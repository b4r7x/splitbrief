import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import type { Config, WorkflowState, Task, Summary, OrchestratorCallbacks, ProjectContext, TokenUsage, ValidationResult, CostBreakdown, TaskTokenUsage, PlannerTool, TuiEvent } from '../types.js';
import { createInitialState, transition, saveState, loadState, appendEvent } from '../state.js';
import { implementTask, retryTask } from './implementer.js';
import { validateTask, formatValidationError } from './validator.js';
import { commitChanges, getCurrentDiff, hasExternalChanges, discardTaskChanges } from '../utils/git.js';
import { ensureTinySpecDir, readSpecFile, writeSpecFile } from '../utils/fs.js';
import { buildFinalReviewPrompt, buildRegeneratePrompt } from './spec/templates.js';
import { killAllProcesses, activeProcesses } from '../utils/process.js';
import { parseStreamLine } from './claude-stream.js';
import type { ClarificationQuestion } from './question-parser.js';

import { getPlannerPricing, getImplementerPricing, calculateCost } from './pricing.js';
import { createPlanner } from './planners/factory.js';
import type { PlannerBackend } from './planners/types.js';

export function supportsConversational(tool: PlannerTool): boolean {
  return tool === 'claude-code' || tool === 'agent-sdk';
}

function persistClarifications(projectDir: string, clarifications: Array<{ question: string; answer: string }>): void {
  if (clarifications.length === 0) return;

  const filename = 'spec.md';
  let content = readSpecFile(projectDir, filename) ?? '';

  const sessionHeader = `### Session ${new Date().toISOString().slice(0, 10)}`;
  const entries = clarifications.map(c => `- Q: ${c.question} \u2192 A: ${c.answer}`).join('\n');

  if (!content.includes('## Clarifications')) {
    content += `\n\n## Clarifications\n\n${sessionHeader}\n${entries}\n`;
  } else if (!content.includes(sessionHeader)) {
    content += `\n${sessionHeader}\n${entries}\n`;
  } else {
    content += `\n${entries}\n`;
  }

  writeSpecFile(projectDir, filename, content);
}

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

function emitValidationStart(callbacks: OrchestratorCallbacks): void {
  callbacks.onEvent({
    type: 'validate', ts: Date.now(), status: 'running', passed: false,
    stages: { tsc: false, lint: false, test: false },
  });
}

export function allValidationsPassed(results: ValidationResult[]): boolean {
  return results.length === 0 || results.every((r) => r.passed);
}

export function hasDependencyFailed(task: Task, failedTasks: string[], skippedTasks: string[]): boolean {
  const blocked = new Set([...failedTasks, ...skippedTasks]);
  return task.dependsOn.some((dep) => blocked.has(dep));
}

function addPlannerUsage(state: WorkflowState, usage: { inputTokens: number; outputTokens: number } | null | undefined): WorkflowState {
  if (!usage) return state;
  return {
    ...state,
    tokenUsage: {
      ...state.tokenUsage,
      plannerInput: state.tokenUsage.plannerInput + usage.inputTokens,
      plannerOutput: state.tokenUsage.plannerOutput + usage.outputTokens,
    },
  };
}

function addImplementerUsage(state: WorkflowState, usage: { promptTokens: number; completionTokens: number } | undefined): WorkflowState {
  if (!usage) return state;
  return {
    ...state,
    tokenUsage: {
      ...state.tokenUsage,
      implementerInput: state.tokenUsage.implementerInput + usage.promptTokens,
      implementerOutput: state.tokenUsage.implementerOutput + usage.completionTokens,
    },
  };
}

function addEscalationUsage(state: WorkflowState, usage: { inputTokens: number; outputTokens: number } | null | undefined): WorkflowState {
  if (!usage) return state;
  return {
    ...state,
    tokenUsage: {
      ...state.tokenUsage,
      escalationInput: state.tokenUsage.escalationInput + usage.inputTokens,
      escalationOutput: state.tokenUsage.escalationOutput + usage.outputTokens,
    },
  };
}

function tokenDelta(before: TokenUsage, after: TokenUsage): { implementerTokens: number; escalationTokens: number } {
  const implBefore = before.implementerInput + before.implementerOutput;
  const implAfter = after.implementerInput + after.implementerOutput;
  const escBefore = before.escalationInput + before.escalationOutput;
  const escAfter = after.escalationInput + after.escalationOutput;
  return {
    implementerTokens: implAfter - implBefore,
    escalationTokens: escAfter - escBefore,
  };
}

type RetryResult = { completed: boolean; method: TaskTokenUsage['method'] };

export function estimateCostSavings(tokenUsage: TokenUsage, plannerTool?: string, implementerProvider?: string): string {
  const breakdown = calculateCostBreakdown(tokenUsage, 0, 0, plannerTool, implementerProvider);
  if (breakdown.savingsAmount <= 0) return '$0.00';
  return `$${breakdown.savingsAmount.toFixed(2)}`;
}

export function calculateCostBreakdown(
  tokenUsage: TokenUsage,
  totalTasks: number,
  escalatedCount: number,
  plannerTool?: string,
  implementerProvider?: string,
): CostBreakdown {
  const plannerPricing = getPlannerPricing(plannerTool ?? 'claude-code');
  const implPricing = getImplementerPricing(implementerProvider ?? 'ollama');

  const hypotheticalCost = calculateCost(
    tokenUsage.implementerInput, tokenUsage.implementerOutput, plannerPricing,
  );

  const actualPlannerCost = calculateCost(
    tokenUsage.plannerInput + tokenUsage.escalationInput,
    tokenUsage.plannerOutput + tokenUsage.escalationOutput,
    plannerPricing,
  );

  const actualImplementerCost = calculateCost(
    tokenUsage.implementerInput, tokenUsage.implementerOutput, implPricing,
  );

  const totalActualCost = actualPlannerCost + actualImplementerCost;
  const savingsAmount = hypotheticalCost - totalActualCost;
  const savingsPercentage = hypotheticalCost > 0 ? (savingsAmount / hypotheticalCost) * 100 : 0;
  const localCompletionRate = totalTasks > 0 ? ((totalTasks - escalatedCount) / totalTasks) * 100 : 0;

  return {
    hypotheticalCost,
    actualPlannerCost,
    actualImplementerCost,
    totalActualCost,
    savingsAmount: Math.max(0, savingsAmount),
    savingsPercentage: Math.max(0, savingsPercentage),
    localCompletionRate,
  };
}

async function runFinalReview(
  projectDir: string,
  callbacks: OrchestratorCallbacks,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } | null }> {
  const diff = await getCurrentDiff(projectDir);
  const spec = readSpecFile(projectDir, 'spec.md') ?? '';
  const prompt = buildFinalReviewPrompt(spec, diff);

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--output-format', 'stream-json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectDir,
    });

    activeProcesses.add(proc);

    let fullResponse = '';
    let stdoutBuffer = '';
    let usage: { inputTokens: number; outputTokens: number } | null = null;

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop()!;
      for (const line of lines) {
        const parsed = parseStreamLine(line);
        if (parsed.text) {
          if (parsed.isResult) {
            fullResponse = parsed.text;
          } else {
            fullResponse += parsed.text;
          }
          callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text: parsed.text });
        }
        if (parsed.usage) {
          usage = parsed.usage;
        }
      }
    });

    proc.on('close', (code) => {
      activeProcesses.delete(proc);

      if (stdoutBuffer) {
        const parsed = parseStreamLine(stdoutBuffer);
        if (parsed.text) {
          if (parsed.isResult) {
            fullResponse = parsed.text;
          } else {
            fullResponse += parsed.text;
          }
          callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text: parsed.text });
        }
        if (parsed.usage) {
          usage = parsed.usage;
        }
      }
      if (code !== 0 && !fullResponse) {
        reject(new Error(`Final review failed with exit code ${code}`));
      } else {
        resolve({ text: fullResponse, usage });
      }
    });

    proc.on('error', (err) => {
      activeProcesses.delete(proc);
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
  savedState?: WorkflowState,
): Promise<Summary> {
  const startTime = Date.now();
  let trackedState: WorkflowState | undefined;
  let currentTask: Task | undefined;

  const shutdown = () => {
    killAllProcesses();
    if (trackedState) {
      try { saveState(projectDir, trackedState); } catch { /* best-effort */ }
    }
    if (currentTask) {
      try { discardTaskChanges(projectDir, currentTask.file, currentTask.action); } catch { /* best-effort, async but fire-and-forget */ }
    }
  };

  const onSignal = () => {
    shutdown();
    process.exit(130);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
  // Pre-start: validate shell implementer config
  if (config.implementer.type === 'shell' && !config.implementer.command) {
    callbacks.onEvent({ type: 'error', ts: Date.now(), message: 'Shell implementer requires implementer.command to be set in config.' });
    return buildSummary(feature, createInitialState(feature), startTime);
  }

  // Step 1: Ensure .tiny-spec directory
  ensureTinySpecDir(projectDir);

  // Create planner backend and check availability
  const planner = await createPlanner(config);
  const available = await planner.isAvailable();
  if (!available) {
    callbacks.onEvent({ type: 'error', ts: Date.now(), message: `Planner '${config.planner.tool}' is not available. Make sure it's installed.` });
    return buildSummary(feature, createInitialState(feature), startTime);
  }

  let state: WorkflowState;

  if (savedState) {
    // Resume path: skip planning, jump to task loop
    state = savedState;
    trackedState = state;
    callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
    emit(projectDir, state, 'workflow_resumed');
  } else {
    // Step 2: Create initial state
    state = createInitialState(feature);
    state = transition(state, { type: 'START', feature });
    saveState(projectDir, state);
    trackedState = state;
    callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
    emit(projectDir, state, 'workflow_started');
  }

  // Step 3: Build project context
  const context = buildContext(projectDir, config);

  if (!savedState) {
  // Step 4: Plan  -  research, spec, plan, tasks
  const collectedQuestions: ClarificationQuestion[] = [];
  const conversational = supportsConversational(config.planner.tool);

  let planResult: Awaited<ReturnType<PlannerBackend['plan']>>;
  try {
    planResult = await planner.plan(feature, projectDir, config, {
      onOutput: (text) => callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text }),
      onPhase: (phase) => {
        // planner emits its own sub-phases; we track spec/plan transitions
      },
      onQuestion: conversational ? (questions) => {
        for (const q of questions) {
          if (collectedQuestions.length < 5) {
            collectedQuestions.push(q);
          }
        }
      } : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    callbacks.onEvent({ type: 'error', ts: Date.now(), message: `Planning failed: ${msg}` });
    state = transition(state, { type: 'CANCEL' });
    saveState(projectDir, state);
    trackedState = state;
    return buildSummary(feature, state, startTime);
  }

  const { tasks } = planResult;

  // Accumulate planner usage
  state = addPlannerUsage(state, planResult.usage);
  saveState(projectDir, state);

  // Advance through intermediate transitions (planner handled research + spec internally)
  state = transition(state, { type: 'RESEARCH_DONE' });
  saveState(projectDir, state);
  emit(projectDir, state, 'research_done');

  // Step 4b: Ask clarification questions (conversational planners only)
  if (conversational && collectedQuestions.length > 0 && callbacks.onQuestionAsked) {
    const clarifications: Array<{ question: string; answer: string }> = [];
    const total = collectedQuestions.length;

    for (let qi = 0; qi < total; qi++) {
      const question = collectedQuestions[qi];
      const answer = await callbacks.onQuestionAsked(question, qi + 1, total);

      if (answer === 'done') break;
      if (answer === 'skip' || answer === '') continue;

      clarifications.push({ question: question.text, answer });
    }

    if (clarifications.length > 0) {
      persistClarifications(projectDir, clarifications);
      emit(projectDir, state, 'clarifications_collected', undefined, {
        count: clarifications.length,
        clarifications,
      });
    }
  }

  // Step 5: Review spec
  state = transition(state, { type: 'SPEC_DONE' });
  saveState(projectDir, state);
  callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
  emit(projectDir, state, 'spec_done');

  const specPath = join(projectDir, '.tiny-spec', 'current', 'spec.md');

  if (!config.workflow.autoApproveSpec) {
    let specDone = false;
    while (!specDone) {
      const specResult = await callbacks.onApprovalNeeded('spec', specPath);
      if (!specResult.approved && !specResult.comment) {
        state = transition(state, { type: 'REJECT_SPEC' });
        saveState(projectDir, state);
        callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'done' });
        emit(projectDir, state, 'spec_rejected');
        return buildSummary(feature, state, startTime);
      }
      if (specResult.comment) {
        const currentSpec = readSpecFile(projectDir, 'spec.md') ?? '';
        const regenPrompt = buildRegeneratePrompt('spec', currentSpec, specResult.comment);
        callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text: `\n[Regenerating spec with feedback: ${specResult.comment}]\n` });
        const regenResult = await planner.regenerate(regenPrompt, 'spec', projectDir, {
          onOutput: (text) => callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text }),
        });
        state = addPlannerUsage(state, regenResult.usage);
        saveState(projectDir, state);
        emit(projectDir, state, 'spec_regenerated', undefined, { comment: specResult.comment });
        continue;
      }
      specDone = true;
    }
  }

  // Step 6: Approve spec -> planning phase (plan already generated)
  state = transition(state, { type: 'APPROVE_SPEC' });
  saveState(projectDir, state);
  callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
  emit(projectDir, state, 'spec_approved');

  // Step 7: Review plan
  state = transition(state, { type: 'PLAN_DONE', tasks });
  saveState(projectDir, state);
  callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
  emit(projectDir, state, 'plan_done', undefined, { taskCount: tasks.length });

  const planPath = join(projectDir, '.tiny-spec', 'current', 'plan.md');

  if (!config.workflow.autoApprovePlan) {
    let planDone = false;
    while (!planDone) {
      const planResult2 = await callbacks.onApprovalNeeded('plan', planPath);
      if (!planResult2.approved && !planResult2.comment) {
        state = transition(state, { type: 'REJECT_PLAN' });
        saveState(projectDir, state);
        callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'done' });
        emit(projectDir, state, 'plan_rejected');
        return buildSummary(feature, state, startTime);
      }
      if (planResult2.comment) {
        const currentPlan = readSpecFile(projectDir, 'plan.md') ?? '';
        const regenPrompt = buildRegeneratePrompt('plan', currentPlan, planResult2.comment);
        callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text: `\n[Regenerating plan with feedback: ${planResult2.comment}]\n` });
        const regenResult = await planner.regenerate(regenPrompt, 'plan', projectDir, {
          onOutput: (text) => callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text }),
        });
        state = addPlannerUsage(state, regenResult.usage);
        saveState(projectDir, state);
        emit(projectDir, state, 'plan_regenerated', undefined, { comment: planResult2.comment });
        continue;
      }
      planDone = true;
    }
  }

  // Step 8: Approve plan -> implementing
  state = transition(state, { type: 'APPROVE_PLAN' });
  saveState(projectDir, state);
  trackedState = state;
  callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
  emit(projectDir, state, 'plan_approved');
  } // end if (!savedState)

  // Step 9: Task loop
  const totalTasks = state.tasks.length;
  const taskBreakdowns: TaskTokenUsage[] = [];

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
      // Not a git repo or git error  -  continue anyway
    }

    // Skip if dependency failed
    if (hasDependencyFailed(task, state.failedTasks, state.skippedTasks)) {
      task.status = 'skipped';
      state = { ...state, skippedTasks: [...state.skippedTasks, task.id] };
      saveState(projectDir, state);
      const skipReason = `dependency failed: ${task.dependsOn.filter((d) => state.failedTasks.includes(d) || state.skippedTasks.includes(d)).join(', ')}`;
      callbacks.onEvent({ type: 'task-skipped', ts: Date.now(), taskId: task.id, title: task.title, reason: skipReason });
      emit(projectDir, state, 'task_skipped', task.id);
      taskBreakdowns.push({ taskId: task.id, taskTitle: task.title, method: 'skipped', implementerTokens: 0, escalationTokens: 0, retryCount: 0 });
      emit(projectDir, state, 'task_tokens', task.id, { method: 'skipped', implementerTokens: 0, escalationTokens: 0, retryCount: 0 });
      // Advance index manually since we're not going through VALIDATION_PASS
      state = { ...state, currentTaskIndex: i + 1 };
      saveState(projectDir, state);
      continue;
    }

    // Start task
    task.status = 'in_progress';
    currentTask = task;
    const taskStartTime = Date.now();
    callbacks.onEvent({ type: 'task-start', ts: taskStartTime, taskId: task.id, title: task.title, index: i, total: totalTasks, file: task.file, action: task.action });
    emit(projectDir, state, 'task_started', task.id);

    // Read current file content for modify tasks
    if (task.action === 'modify') {
      const filePath = join(projectDir, task.file);
      if (existsSync(filePath)) {
        task.currentCode = readFileSync(filePath, 'utf-8');
      }
    }

    // Snapshot token usage before this task
    const tokensBefore = { ...state.tokenUsage };

    // Implement
    const implResult = await implementTask(task, projectDir, config, context, (text) => {
      callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text });
    }, callbacks.onEvent);

    // Track implementer usage
    state = addImplementerUsage(state, implResult.usage);
    saveState(projectDir, state);

    if (!implResult.success) {
      const retryResult = await handleRetryAndEscalation(
        task, implResult.error ?? 'Implementation failed to produce valid code',
        projectDir, config, context, callbacks, state, taskStartTime,
      );
      state = reloadState(projectDir, state);
      trackedState = state;
      const delta = tokenDelta(tokensBefore, state.tokenUsage);
      const taskUsage: TaskTokenUsage = {
        taskId: task.id, taskTitle: task.title, method: retryResult.method,
        implementerTokens: delta.implementerTokens, escalationTokens: delta.escalationTokens,
        retryCount: state.attempt,
      };
      taskBreakdowns.push(taskUsage);
      emit(projectDir, state, 'task_tokens', task.id, { method: taskUsage.method, implementerTokens: taskUsage.implementerTokens, escalationTokens: taskUsage.escalationTokens, retryCount: taskUsage.retryCount });
      if (!retryResult.completed) {
        emit(projectDir, state, 'task_failed', task.id);
      }
      continue;
    }

    // Validate
    state = transition(state, { type: 'TASK_SENT' });
    saveState(projectDir, state);

    const valStartTime = Date.now();
    emitValidationStart(callbacks);
    const validationResults = await validateTask(task, projectDir, config);
    const valPassed = validationResults.length === 0 || validationResults.every(r => r.passed);
    const failedStage = validationResults.find(r => !r.passed);
    callbacks.onEvent({
      type: 'validate', ts: Date.now(), status: 'done', passed: valPassed,
      stages: {
        tsc: validationResults.find(r => r.stage === 'typecheck')?.passed ?? true,
        lint: validationResults.find(r => r.stage === 'lint')?.passed ?? true,
        test: validationResults.find(r => r.stage === 'test')?.passed ?? true,
      },
      error: failedStage?.error,
      duration: Date.now() - valStartTime,
    });

    {
      const result = await validateCommitAndAdvance(task, validationResults, projectDir, config, state, callbacks, 'local', 'VALIDATION_PASS', undefined, taskStartTime);
      if (result.completed) {
        state = result.state;
        const delta = tokenDelta(tokensBefore, state.tokenUsage);
        const taskUsage: TaskTokenUsage = {
          taskId: task.id, taskTitle: task.title, method: 'local',
          implementerTokens: delta.implementerTokens, escalationTokens: delta.escalationTokens,
          retryCount: 0,
        };
        taskBreakdowns.push(taskUsage);
        emit(projectDir, state, 'task_tokens', task.id, { method: taskUsage.method, implementerTokens: taskUsage.implementerTokens, escalationTokens: taskUsage.escalationTokens, retryCount: taskUsage.retryCount });
        continue;
      }
    }

    // Validation failed  -  enter retry loop
    const errorText = formatValidationError(validationResults);
    const retryResult2 = await handleRetryAndEscalation(
      task, errorText, projectDir, config, context, callbacks, state, taskStartTime,
    );
    state = reloadState(projectDir, state);
    trackedState = state;
    const delta = tokenDelta(tokensBefore, state.tokenUsage);
    const taskUsage: TaskTokenUsage = {
      taskId: task.id, taskTitle: task.title, method: retryResult2.method,
      implementerTokens: delta.implementerTokens, escalationTokens: delta.escalationTokens,
      retryCount: state.attempt,
    };
    taskBreakdowns.push(taskUsage);
    emit(projectDir, state, 'task_tokens', task.id, { method: taskUsage.method, implementerTokens: taskUsage.implementerTokens, escalationTokens: taskUsage.escalationTokens, retryCount: taskUsage.retryCount });
    if (!retryResult2.completed) {
      emit(projectDir, state, 'task_failed', task.id);
    }
  }
  currentTask = undefined;

  // Step 10: Final review
  state = transition(state, { type: 'ALL_DONE' });
  saveState(projectDir, state);
  const finalReviewStart = Date.now();
  callbacks.onEvent({ type: 'planner-status', ts: finalReviewStart, phase: state.phase, status: 'running' });
  emit(projectDir, state, 'all_tasks_done');

  try {
    const reviewResult = await runFinalReview(projectDir, callbacks);
    writeSpecFile(projectDir, 'review.md', reviewResult.text);
    state = addPlannerUsage(state, reviewResult.usage);
    saveState(projectDir, state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    callbacks.onEvent({ type: 'error', ts: Date.now(), message: `Final review failed: ${msg}` });
    // Non-fatal  -  we still complete
  }

  state = transition(state, { type: 'REVIEW_DONE' });
  saveState(projectDir, state);
  callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'done', duration: Date.now() - finalReviewStart });
  emit(projectDir, state, 'workflow_complete');

  // Step 11: Build summary
  const summary = buildSummary(feature, state, startTime, taskBreakdowns);
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
    callbacks.onEvent({ type: 'error', ts: Date.now(), message: msg });
    return buildSummary(feature, trackedState ?? createInitialState(feature), startTime);
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

async function validateCommitAndAdvance(
  task: Task,
  results: ValidationResult[],
  projectDir: string,
  config: Config,
  state: WorkflowState,
  callbacks: OrchestratorCallbacks,
  method: 'local' | 'local_with_hints' | 'escalated',
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS',
  commitSuffix?: string,
  taskStartTime?: number,
): Promise<{ state: WorkflowState; completed: boolean }> {
  if (!allValidationsPassed(results)) {
    return { state, completed: false };
  }

  if (config.workflow.commitPerTask) {
    const suffix = commitSuffix ? ` (${commitSuffix})` : '';
    const commitMsg = `feat(tiny-spec): ${task.id} - ${task.title}${suffix}`;
    try {
      await commitChanges(projectDir, commitMsg);
      callbacks.onEvent({ type: 'git-commit', ts: Date.now(), message: commitMsg });
    } catch {
      // commit failure is non-fatal
    }
  }

  const nextState = transition(state, { type: transitionType });
  saveState(projectDir, nextState);
  task.status = method === 'escalated' ? 'escalated' : 'done';
  const taskMethod = method === 'escalated' ? 'escalated' as const : 'local' as const;
  callbacks.onEvent({
    type: 'task-complete', ts: Date.now(), taskId: task.id, title: task.title,
    method: taskMethod, retries: state.attempt,
    duration: taskStartTime ? Date.now() - taskStartTime : 0,
  });
  emit(projectDir, nextState, 'task_completed', task.id, { method });

  return { state: nextState, completed: true };
}

async function handleRetryAndEscalation(
  task: Task,
  initialError: string,
  projectDir: string,
  config: Config,
  context: ProjectContext,
  callbacks: OrchestratorCallbacks,
  currentState: WorkflowState,
  taskStartTime?: number,
): Promise<RetryResult> {
  let state = currentState;
  let lastError = initialError;
  const maxRetries = config.workflow.maxRetries;

  // Retry loop
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    state = transition(state, { type: 'VALIDATION_FAIL' }, config.workflow.maxRetries);
    saveState(projectDir, state);
    callbacks.onEvent({ type: 'retry', ts: Date.now(), taskId: task.id, attempt, maxRetries });
    emit(projectDir, state, 'task_retry', task.id, { attempt, error: lastError });

    // Read current file content for retry context
    if (task.action === 'modify' || task.action === 'create') {
      const filePath = join(projectDir, task.file);
      if (existsSync(filePath)) {
        task.currentCode = readFileSync(filePath, 'utf-8');
      }
    }

    const retryResult = await retryTask(task, projectDir, config, context, lastError, attempt, (text) => {
      callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text });
    }, callbacks.onEvent);

    state = addImplementerUsage(state, retryResult.usage);
    saveState(projectDir, state);

    if (!retryResult.success) {
      lastError = retryResult.error ?? 'Retry failed to produce valid code';
      continue;
    }

    // Validate retry
    const retryValStart = Date.now();
    emitValidationStart(callbacks);
    const retryValidation = await validateTask(task, projectDir, config);
    const retryValPassed = retryValidation.length === 0 || retryValidation.every(r => r.passed);
    const retryFailedStage = retryValidation.find(r => !r.passed);
    callbacks.onEvent({
      type: 'validate', ts: Date.now(), status: 'done', passed: retryValPassed,
      stages: {
        tsc: retryValidation.find(r => r.stage === 'typecheck')?.passed ?? true,
        lint: retryValidation.find(r => r.stage === 'lint')?.passed ?? true,
        test: retryValidation.find(r => r.stage === 'test')?.passed ?? true,
      },
      error: retryFailedStage?.error,
      duration: Date.now() - retryValStart,
    });

    {
      const result = await validateCommitAndAdvance(task, retryValidation, projectDir, config, state, callbacks, 'local', 'VALIDATION_PASS', undefined, taskStartTime);
      if (result.completed) {
        state = result.state;
        return { completed: true, method: 'local' };
      }
    }

    lastError = formatValidationError(retryValidation);
  }

  // Max retries exhausted  -  escalate
  state = transition(state, { type: 'ESCALATE' });
  saveState(projectDir, state);
  callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: String(state.phase), status: 'running' });
  emit(projectDir, state, 'task_escalating', task.id);

  // Tier 1: Get hints from Opus
  callbacks.onEvent({ type: 'escalate', ts: Date.now(), tier: 1 });
  const planner = await createPlanner(config);
  const tier1Result = await planner.escalateHint(task, lastError, projectDir, {
    onOutput: (text) => callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text }),
  });

  state = addEscalationUsage(state, tier1Result.usage);
  saveState(projectDir, state);

  // Emit hint text
  if (tier1Result.output) {
    callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text: tier1Result.output });
  }

  // Feed hints back to local model as one more retry
  const hintError = `${lastError}\n\n## Hints from senior reviewer:\n${tier1Result.output}`;

  // Read current code again
  const filePath = join(projectDir, task.file);
  if (existsSync(filePath)) {
    task.currentCode = readFileSync(filePath, 'utf-8');
  }

  const hintRetryResult = await retryTask(task, projectDir, config, context, hintError, maxRetries + 1, (text) => {
    callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text });
  }, callbacks.onEvent);

  state = addImplementerUsage(state, hintRetryResult.usage);
  saveState(projectDir, state);

  if (hintRetryResult.success) {
    const hintValStart = Date.now();
    emitValidationStart(callbacks);
    const hintValidation = await validateTask(task, projectDir, config);
    const hintValPassed = hintValidation.length === 0 || hintValidation.every(r => r.passed);
    const hintFailedStage = hintValidation.find(r => !r.passed);
    callbacks.onEvent({
      type: 'validate', ts: Date.now(), status: 'done', passed: hintValPassed,
      stages: {
        tsc: hintValidation.find(r => r.stage === 'typecheck')?.passed ?? true,
        lint: hintValidation.find(r => r.stage === 'lint')?.passed ?? true,
        test: hintValidation.find(r => r.stage === 'test')?.passed ?? true,
      },
      error: hintFailedStage?.error,
      duration: Date.now() - hintValStart,
    });

    const result = await validateCommitAndAdvance(task, hintValidation, projectDir, config, state, callbacks, 'local_with_hints', 'HINT_SUCCESS', 'with hints', taskStartTime);
    if (result.completed) {
      return { completed: true, method: 'escalated-hint' };
    }
  }

  // Hint didn't work  -  Tier 2: Full Opus implementation
  state = transition(state, { type: 'HINT_FAIL' });
  saveState(projectDir, state);
  emit(projectDir, state, 'hint_failed', task.id);

  callbacks.onEvent({ type: 'escalate', ts: Date.now(), tier: 2 });
  const tier2Result = await planner.escalateFull(task, lastError, projectDir, {
    onOutput: (text) => callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text }),
  });

  state = addEscalationUsage(state, tier2Result.usage);
  saveState(projectDir, state);

  if (tier2Result.success) {
    const tier2ValStart = Date.now();
    emitValidationStart(callbacks);
    const tier2Validation = await validateTask(task, projectDir, config);
    const tier2ValPassed = tier2Validation.length === 0 || tier2Validation.every(r => r.passed);
    const tier2FailedStage = tier2Validation.find(r => !r.passed);
    callbacks.onEvent({
      type: 'validate', ts: Date.now(), status: 'done', passed: tier2ValPassed,
      stages: {
        tsc: tier2Validation.find(r => r.stage === 'typecheck')?.passed ?? true,
        lint: tier2Validation.find(r => r.stage === 'lint')?.passed ?? true,
        test: tier2Validation.find(r => r.stage === 'test')?.passed ?? true,
      },
      error: tier2FailedStage?.error,
      duration: Date.now() - tier2ValStart,
    });

    const result = await validateCommitAndAdvance(task, tier2Validation, projectDir, config, state, callbacks, 'escalated', 'FULL_SUCCESS', 'escalated', taskStartTime);
    if (result.completed) {
      return { completed: true, method: 'escalated-full' };
    }
  }

  // Tier 2 also failed  -  mark as failed, discard uncommitted changes (FR-012)
  state = transition(state, { type: 'FULL_FAIL' });
  saveState(projectDir, state);
  task.status = 'failed';
  emit(projectDir, state, 'task_full_fail', task.id);
  try { await discardTaskChanges(projectDir, task.file, task.action); } catch { /* best effort */ }
  return { completed: false, method: 'failed' };
}

function reloadState(projectDir: string, fallback: WorkflowState): WorkflowState {
  return loadState(projectDir) ?? fallback;
}

function buildSummary(feature: string, state: WorkflowState, startTime: number, taskBreakdowns?: TaskTokenUsage[]): Summary {
  const totalTasks = state.tasks.length;
  const completedByLocal = state.completedTasks.length;
  const escalatedToPlanner = state.escalatedTasks.length;
  const skipped = state.skippedTasks.length;
  const failed = state.failedTasks.length;
  const totalTime = Date.now() - startTime;
  const escalationRate = totalTasks > 0 ? escalatedToPlanner / totalTasks : 0;

  return {
    feature,
    totalTasks,
    completedByLocal,
    escalatedToPlanner,
    skipped,
    failed,
    totalTime,
    tokenUsage: state.tokenUsage,
    estimatedCostSavings: estimateCostSavings(state.tokenUsage),
    escalationRate,
    taskBreakdown: taskBreakdowns,
  };
}
