import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Config, WorkflowState, Task, Summary, OrchestratorCallbacks, ProjectContext, TokenUsage, ValidationResult } from '../types.js';
import { createInitialState, transition, saveState, loadState, appendEvent } from '../state.js';
import { planFeature } from './planner.js';
import { implementTask, retryTask } from './implementer.js';
import { validateTask, formatValidationError } from './validator.js';
import { escalateTask } from './escalator.js';
import { commitChanges, getCurrentDiff, hasExternalChanges, discardUncommittedChanges } from '../utils/git.js';
import { ensureTinySpecDir, readSpecFile, writeSpecFile } from '../utils/fs.js';
import { buildFinalReviewPrompt } from '../spec/templates.js';
import { killAllProcesses } from '../utils/process.js';

// Opus pricing per 1M tokens (USD)
const OPUS_INPUT_PRICE = 15;
const OPUS_OUTPUT_PRICE = 75;

function buildContext(projectDir: string, config: Config): ProjectContext {
  let name = 'unknown';
  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      name = pkg.name ?? 'unknown';
    } catch {
      // ignore
    }
  }

  return {
    name,
    dir: projectDir,
    runtime: 'node',
    testCommand: config.validation.testCommand,
  };
}

function emit(projectDir: string, state: WorkflowState, type: string, taskId?: string, data?: Record<string, unknown>): void {
  appendEvent(projectDir, {
    ts: Date.now(),
    type,
    taskId,
    phase: state.phase,
    data,
  });
}

function allValidationsPassed(results: ValidationResult[]): boolean {
  return results.length === 0 || results.every((r) => r.passed);
}

function hasDependencyFailed(task: Task, failedTasks: string[], skippedTasks: string[]): boolean {
  const blocked = new Set([...failedTasks, ...skippedTasks]);
  return task.dependsOn.some((dep) => blocked.has(dep));
}

function estimateCostSavings(tokenUsage: TokenUsage): string {
  // If all implementer work had been done by Opus instead, how much would it have cost?
  const hypotheticalOpusCost =
    (tokenUsage.implementerInput / 1_000_000) * OPUS_INPUT_PRICE +
    (tokenUsage.implementerOutput / 1_000_000) * OPUS_OUTPUT_PRICE;

  // Actual Opus cost (planning + escalation)
  const actualOpusCost =
    ((tokenUsage.plannerInput + tokenUsage.escalationInput) / 1_000_000) * OPUS_INPUT_PRICE +
    ((tokenUsage.plannerOutput + tokenUsage.escalationOutput) / 1_000_000) * OPUS_OUTPUT_PRICE;

  // Local model cost is effectively zero
  const savings = hypotheticalOpusCost - actualOpusCost;

  if (savings <= 0) return '$0.00';
  return `$${savings.toFixed(2)}`;
}

function parseReviewStreamLine(line: string): { text: string | null; isResult: boolean } {
  if (!line.trim()) return { text: null, isResult: false };
  try {
    const event = JSON.parse(line);
    if (event.type === 'assistant' && event.message?.content) {
      const texts: string[] = [];
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) texts.push(block.text);
      }
      return { text: texts.length > 0 ? texts.join('') : null, isResult: false };
    }
    if (event.type === 'result' && typeof event.result === 'string') {
      return { text: event.result, isResult: true };
    }
  } catch {
    // non-JSON line
  }
  return { text: null, isResult: false };
}

async function runFinalReview(
  projectDir: string,
  callbacks: OrchestratorCallbacks,
): Promise<string> {
  const diff = await getCurrentDiff(projectDir);
  const spec = readSpecFile(projectDir, 'spec.md') ?? '';
  const prompt = buildFinalReviewPrompt(spec, diff);

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--output-format', 'stream-json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectDir,
    });

    let fullResponse = '';
    let stdoutBuffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop()!;
      for (const line of lines) {
        const { text, isResult } = parseReviewStreamLine(line);
        if (text) {
          if (isResult) {
            fullResponse = text;
          } else {
            fullResponse += text;
          }
          callbacks.onPlannerOutput(text);
        }
      }
    });

    proc.on('close', (code) => {
      if (stdoutBuffer) {
        const { text, isResult } = parseReviewStreamLine(stdoutBuffer);
        if (text) {
          if (isResult) {
            fullResponse = text;
          } else {
            fullResponse += text;
          }
          callbacks.onPlannerOutput(text);
        }
      }
      if (code !== 0 && !fullResponse) {
        reject(new Error(`Final review failed with exit code ${code}`));
      } else {
        resolve(fullResponse);
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export async function runWorkflow(
  feature: string,
  projectDir: string,
  config: Config,
  callbacks: OrchestratorCallbacks,
): Promise<Summary> {
  const startTime = Date.now();
  let trackedState: WorkflowState | undefined;

  const shutdown = () => {
    killAllProcesses();
    if (trackedState) {
      try { saveState(projectDir, trackedState); } catch { /* best-effort */ }
    }
    try { discardUncommittedChanges(projectDir); } catch { /* best-effort, async but fire-and-forget */ }
  };

  const onSignal = () => {
    shutdown();
    process.exit(130);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
  // Step 1: Ensure .tiny-spec directory
  ensureTinySpecDir(projectDir);

  // Step 2: Create initial state
  let state = createInitialState(feature);
  state = transition(state, { type: 'START', feature });
  saveState(projectDir, state);
  trackedState = state;
  callbacks.onPhaseChange(state.phase);
  emit(projectDir, state, 'workflow_started');

  // Step 3: Build project context
  const context = buildContext(projectDir, config);

  // Step 4: Plan — research, spec, plan, tasks
  let planResult: Awaited<ReturnType<typeof planFeature>>;
  try {
    planResult = await planFeature(feature, projectDir, config, {
      onOutput: (text) => callbacks.onPlannerOutput(text),
      onPhase: (phase) => {
        // planner emits its own sub-phases; we track spec/plan transitions
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    callbacks.onError(`Planning failed: ${msg}`);
    state = transition(state, { type: 'CANCEL' });
    saveState(projectDir, state);
    trackedState = state;
    return buildSummary(feature, state, startTime);
  }

  const { tasks } = planResult;

  // Advance through intermediate transitions (planner handled research + spec internally)
  state = transition(state, { type: 'RESEARCH_DONE' });
  saveState(projectDir, state);
  emit(projectDir, state, 'research_done');

  // Step 5: Review spec
  state = transition(state, { type: 'SPEC_DONE' });
  saveState(projectDir, state);
  callbacks.onPhaseChange(state.phase);
  emit(projectDir, state, 'spec_done');

  const specPath = join(projectDir, '.tiny-spec', 'current', 'spec.md');

  if (!config.workflow.autoApproveSpec) {
    const specApproved = await callbacks.onApprovalNeeded('spec', specPath);
    if (!specApproved) {
      state = transition(state, { type: 'REJECT_SPEC' });
      saveState(projectDir, state);
      callbacks.onPhaseChange(state.phase);
      emit(projectDir, state, 'spec_rejected');
      return buildSummary(feature, state, startTime);
    }
  }

  // Step 6: Approve spec -> planning phase (plan already generated)
  state = transition(state, { type: 'APPROVE_SPEC' });
  saveState(projectDir, state);
  callbacks.onPhaseChange(state.phase);
  emit(projectDir, state, 'spec_approved');

  // Step 7: Review plan
  state = transition(state, { type: 'PLAN_DONE', tasks });
  saveState(projectDir, state);
  callbacks.onPhaseChange(state.phase);
  emit(projectDir, state, 'plan_done', undefined, { taskCount: tasks.length });

  const planPath = join(projectDir, '.tiny-spec', 'current', 'plan.md');

  if (!config.workflow.autoApprovePlan) {
    const planApproved = await callbacks.onApprovalNeeded('plan', planPath);
    if (!planApproved) {
      state = transition(state, { type: 'REJECT_PLAN' });
      saveState(projectDir, state);
      callbacks.onPhaseChange(state.phase);
      emit(projectDir, state, 'plan_rejected');
      return buildSummary(feature, state, startTime);
    }
  }

  // Step 8: Approve plan -> implementing
  state = transition(state, { type: 'APPROVE_PLAN' });
  saveState(projectDir, state);
  trackedState = state;
  callbacks.onPhaseChange(state.phase);
  emit(projectDir, state, 'plan_approved');

  // Step 9: Task loop
  const totalTasks = state.tasks.length;

  for (let i = state.currentTaskIndex; i < totalTasks; i++) {
    const task = state.tasks[i];

    // Check for external changes
    try {
      const externalChanges = await hasExternalChanges(projectDir);
      if (externalChanges) {
        const proceed = await callbacks.onExternalChanges();
        if (!proceed) {
          emit(projectDir, state, 'paused_external_changes', task.id);
          state = transition(state, { type: 'CANCEL' });
          saveState(projectDir, state);
          return buildSummary(feature, state, startTime);
        }
      }
    } catch {
      // Not a git repo or git error — continue anyway
    }

    // Skip if dependency failed
    if (hasDependencyFailed(task, state.failedTasks, state.skippedTasks)) {
      task.status = 'skipped';
      state = { ...state, skippedTasks: [...state.skippedTasks, task.id] };
      saveState(projectDir, state);
      callbacks.onTaskSkipped(task, `dependency failed: ${task.dependsOn.filter((d) => state.failedTasks.includes(d) || state.skippedTasks.includes(d)).join(', ')}`);
      emit(projectDir, state, 'task_skipped', task.id);
      // Advance index manually since we're not going through VALIDATION_PASS
      state = { ...state, currentTaskIndex: i + 1 };
      saveState(projectDir, state);
      continue;
    }

    // Start task
    task.status = 'in_progress';
    callbacks.onTaskStart(task, i, totalTasks);
    emit(projectDir, state, 'task_started', task.id);

    // Read current file content for modify tasks
    if (task.action === 'modify') {
      const filePath = join(projectDir, task.file);
      if (existsSync(filePath)) {
        task.currentCode = readFileSync(filePath, 'utf-8');
      }
    }

    // Implement
    const implResult = await implementTask(task, projectDir, config, context, (text) => {
      callbacks.onImplementerOutput(text);
    });

    if (!implResult.success) {
      // Implementation itself failed (couldn't extract code, etc.)
      // Treat as a validation failure and enter retry loop
      const completed = await handleRetryAndEscalation(
        task, implResult.error ?? 'Implementation failed to produce valid code',
        projectDir, config, context, callbacks, state,
      );
      state = reloadState(projectDir, state);
      trackedState = state;
      if (!completed) {
        emit(projectDir, state, 'task_failed', task.id);
      }
      continue;
    }

    // Validate
    state = transition(state, { type: 'TASK_SENT' });
    saveState(projectDir, state);

    const validationResults = await validateTask(task, projectDir, config);
    callbacks.onValidationResult(task, validationResults);

    if (allValidationsPassed(validationResults)) {
      // Success on first try
      if (config.workflow.commitPerTask) {
        try {
          await commitChanges(projectDir, `feat(tiny-spec): ${task.id} - ${task.title}`);
        } catch {
          // commit failure is non-fatal
        }
      }
      state = transition(state, { type: 'VALIDATION_PASS' });
      saveState(projectDir, state);
      task.status = 'done';
      callbacks.onTaskComplete(task, 'local');
      emit(projectDir, state, 'task_completed', task.id, { method: 'local' });
      continue;
    }

    // Validation failed — enter retry loop
    const errorText = formatValidationError(validationResults);
    const completed = await handleRetryAndEscalation(
      task, errorText, projectDir, config, context, callbacks, state,
    );
    state = reloadState(projectDir, state);
    trackedState = state;
    if (!completed) {
      emit(projectDir, state, 'task_failed', task.id);
    }
  }

  // Step 10: Final review
  state = transition(state, { type: 'ALL_DONE' });
  saveState(projectDir, state);
  callbacks.onPhaseChange(state.phase);
  emit(projectDir, state, 'all_tasks_done');

  try {
    const reviewOutput = await runFinalReview(projectDir, callbacks);
    writeSpecFile(projectDir, 'review.md', reviewOutput);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    callbacks.onError(`Final review failed: ${msg}`);
    // Non-fatal — we still complete
  }

  state = transition(state, { type: 'REVIEW_DONE' });
  saveState(projectDir, state);
  callbacks.onPhaseChange(state.phase);
  emit(projectDir, state, 'workflow_complete');

  // Step 11: Build summary
  const summary = buildSummary(feature, state, startTime);
  callbacks.onComplete(summary);
  return summary;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (trackedState) {
      try {
        trackedState = transition(trackedState, { type: 'CANCEL' });
        saveState(projectDir, trackedState);
      } catch { /* best-effort */ }
    }
    killAllProcesses();
    callbacks.onError(msg);
    return buildSummary(feature, trackedState ?? createInitialState(feature), startTime);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

async function handleRetryAndEscalation(
  task: Task,
  initialError: string,
  projectDir: string,
  config: Config,
  context: ProjectContext,
  callbacks: OrchestratorCallbacks,
  currentState: WorkflowState,
): Promise<boolean> {
  let state = currentState;
  let lastError = initialError;
  const maxRetries = config.workflow.maxRetries;

  // Retry loop
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    state = transition(state, { type: 'VALIDATION_FAIL' });
    saveState(projectDir, state);
    callbacks.onTaskRetry(task, attempt, lastError);
    emit(projectDir, state, 'task_retry', task.id, { attempt, error: lastError });

    // Read current file content for retry context
    if (task.action === 'modify' || task.action === 'create') {
      const filePath = join(projectDir, task.file);
      if (existsSync(filePath)) {
        task.currentCode = readFileSync(filePath, 'utf-8');
      }
    }

    const retryResult = await retryTask(task, projectDir, config, context, lastError, attempt, (text) => {
      callbacks.onImplementerOutput(text);
    });

    if (!retryResult.success) {
      lastError = retryResult.error ?? 'Retry failed to produce valid code';
      continue;
    }

    // Validate retry
    const retryValidation = await validateTask(task, projectDir, config);
    callbacks.onValidationResult(task, retryValidation);

    if (allValidationsPassed(retryValidation)) {
      if (config.workflow.commitPerTask) {
        try {
          await commitChanges(projectDir, `feat(tiny-spec): ${task.id} - ${task.title}`);
        } catch {
          // non-fatal
        }
      }
      state = transition(state, { type: 'VALIDATION_PASS' });
      saveState(projectDir, state);
      task.status = 'done';
      callbacks.onTaskComplete(task, 'local');
      emit(projectDir, state, 'task_completed', task.id, { method: 'local', attempts: attempt + 1 });
      return true;
    }

    lastError = formatValidationError(retryValidation);
  }

  // Max retries exhausted — escalate
  state = transition(state, { type: 'ESCALATE' });
  saveState(projectDir, state);
  callbacks.onPhaseChange(state.phase);
  emit(projectDir, state, 'task_escalating', task.id);

  // Tier 1: Get hints from Opus
  const tier1Result = await escalateTask(task, lastError, projectDir, config, context, {
    onOutput: (text) => callbacks.onPlannerOutput(text),
  });

  // Feed hints back to local model as one more retry
  const hintError = `${lastError}\n\n## Hints from senior reviewer:\n${tier1Result.output}`;

  // Read current code again
  const filePath = join(projectDir, task.file);
  if (existsSync(filePath)) {
    task.currentCode = readFileSync(filePath, 'utf-8');
  }

  const hintRetryResult = await retryTask(task, projectDir, config, context, hintError, maxRetries + 1, (text) => {
    callbacks.onImplementerOutput(text);
  });

  if (hintRetryResult.success) {
    const hintValidation = await validateTask(task, projectDir, config);
    callbacks.onValidationResult(task, hintValidation);

    if (allValidationsPassed(hintValidation)) {
      if (config.workflow.commitPerTask) {
        try {
          await commitChanges(projectDir, `feat(tiny-spec): ${task.id} - ${task.title} (with hints)`);
        } catch {
          // non-fatal
        }
      }
      state = transition(state, { type: 'HINT_SUCCESS' });
      saveState(projectDir, state);
      task.status = 'done';
      callbacks.onTaskComplete(task, 'local');
      emit(projectDir, state, 'task_completed', task.id, { method: 'local_with_hints' });
      return true;
    }
  }

  // Hint didn't work — Tier 2: Full Opus implementation
  state = transition(state, { type: 'HINT_FAIL' });
  saveState(projectDir, state);
  emit(projectDir, state, 'hint_failed', task.id);

  const tier2Result = await escalateTask(task, lastError, projectDir, config, context, {
    onOutput: (text) => callbacks.onPlannerOutput(text),
  }, 2);

  if (tier2Result.success) {
    const tier2Validation = await validateTask(task, projectDir, config);
    callbacks.onValidationResult(task, tier2Validation);

    if (allValidationsPassed(tier2Validation)) {
      if (config.workflow.commitPerTask) {
        try {
          await commitChanges(projectDir, `feat(tiny-spec): ${task.id} - ${task.title} (escalated)`);
        } catch {
          // non-fatal
        }
      }
      state = transition(state, { type: 'FULL_SUCCESS' });
      saveState(projectDir, state);
      task.status = 'escalated';
      callbacks.onTaskComplete(task, 'escalated');
      emit(projectDir, state, 'task_completed', task.id, { method: 'escalated' });
      return true;
    }
  }

  // Tier 2 also failed — mark as failed, discard uncommitted changes (FR-012)
  state = transition(state, { type: 'FULL_FAIL' });
  saveState(projectDir, state);
  task.status = 'failed';
  emit(projectDir, state, 'task_full_fail', task.id);
  try { await discardUncommittedChanges(projectDir); } catch { /* best effort */ }
  return false;
}

function reloadState(projectDir: string, fallback: WorkflowState): WorkflowState {
  return loadState(projectDir) ?? fallback;
}

function buildSummary(feature: string, state: WorkflowState, startTime: number): Summary {
  const totalTasks = state.tasks.length;
  const completedByLocal = state.completedTasks.length;
  const escalatedToOpus = state.escalatedTasks.length;
  const skipped = state.skippedTasks.length;
  const failed = state.failedTasks.length;
  const totalTime = Date.now() - startTime;
  const escalationRate = totalTasks > 0 ? escalatedToOpus / totalTasks : 0;

  return {
    feature,
    totalTasks,
    completedByLocal,
    escalatedToOpus,
    skipped,
    failed,
    totalTime,
    tokenUsage: state.tokenUsage,
    estimatedCostSavings: estimateCostSavings(state.tokenUsage),
    escalationRate,
  };
}
