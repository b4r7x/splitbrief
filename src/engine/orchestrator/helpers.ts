import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Task, WorkflowState, TokenDelta, ValidationResult, OrchestratorCallbacks, StateAction, Config, TaskCompletionMethod } from '../../types.js';
import { labelError } from '../../utils/format.js';
import { isENOENT } from '../../utils/process-errors.js';
import { transition } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, REVIEW_FILE } from '../../core/paths.js';
import { addUsage, type UsageCategory } from './tokens.js';
import { createTextHandler, emitWarning, emitCostUpdate } from './events.js';
import type { Planner } from '../planners/types.js';
import { runValidationWithEvents } from './validator.js';
import { validateCommitAndAdvance } from './task-commit.js';

export function transitionAndSave(
  projectDir: string,
  state: WorkflowState,
  action: StateAction,
  maxRetries?: number,
): WorkflowState {
  const next = transition(state, action, maxRetries);
  saveState(projectDir, next);
  return next;
}

export async function refreshCurrentCode(task: Task, projectDir: string): Promise<Task> {
  const filePath = join(projectDir, task.file);
  try {
    const currentCode = await readFile(filePath, 'utf-8');
    return { ...task, currentCode };
  } catch (err) {
    if (isENOENT(err)) return task;
    throw err;
  }
}

export async function refreshAndPersistCode(
  task: Task, projectDir: string, state: WorkflowState,
): Promise<{ task: Task; state: WorkflowState }> {
  const refreshed = await refreshCurrentCode(task, projectDir);
  if (refreshed.currentCode !== undefined) {
    state = transitionAndSave(projectDir, state, { type: 'UPDATE_TASK_CODE', taskId: refreshed.id, code: refreshed.currentCode });
  }
  return { task: refreshed, state };
}

export function allValidationsPassed(results: ValidationResult[]): boolean {
  return results.every((r) => r.passed);
}

export function addUsageAndSave(
  projectDir: string, state: WorkflowState, category: UsageCategory, usage: TokenDelta | null | undefined,
  callbacks: OrchestratorCallbacks,
): WorkflowState {
  const next = addUsage(state, category, usage);
  saveState(projectDir, next);
  if (usage) {
    emitCostUpdate(callbacks, next.tokenUsage);
  }
  return next;
}

type RunPlannerReviewOptions = {
  planner: Planner;
  prompt: string;
  projectDir: string;
  callbacks: OrchestratorCallbacks;
  state: WorkflowState;
  metadata?: SpecMetadata | null | undefined;
  writeTo?: typeof SPEC_FILE | typeof PLAN_FILE | typeof TASKS_FILE | typeof REVIEW_FILE;
};

export async function runPlannerReview(
  opts: RunPlannerReviewOptions,
): Promise<{ state: WorkflowState; text: string }> {
  const { planner, prompt, projectDir, callbacks, writeTo, metadata } = opts;
  const result = await planner.review(prompt, projectDir, {
    onOutput: createTextHandler(callbacks),
  });
  const state = addUsageAndSave(projectDir, opts.state, 'planner', result.usage, callbacks);
  if (writeTo) writeSpecFile(projectDir, writeTo, result.text, metadata);
  return { state, text: result.text };
}

export async function withSignalHandlers(
  handler: () => void,
  fn: () => Promise<void>,
): Promise<{ cancelled: boolean }> {
  let receivedSignal = false;

  const onSignal = () => {
    receivedSignal = true;
    handler();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await fn();
    return { cancelled: receivedSignal };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

export async function warnOnFailure(
  callbacks: OrchestratorCallbacks,
  action: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    emitWarning(callbacks, labelError(`Failed to ${action}`, err));
  }
}

type ValidateAndCommitTaskOpts = {
  task: Task;
  projectDir: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  state: WorkflowState;
  method: TaskCompletionMethod;
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS';
  commitSuffix?: string | undefined;
  taskStartTime?: number | undefined;
  retryCount?: number | undefined;
};

export async function validateAndCommitTask(
  opts: ValidateAndCommitTaskOpts,
): Promise<{ state: WorkflowState; completed: boolean; validationResults: ValidationResult[] }> {
  const validationResults = await runValidationWithEvents(opts.task, opts.projectDir, opts.config, opts.callbacks);
  const result = await validateCommitAndAdvance({
    ...opts, results: validationResults,
  });
  return { ...result, validationResults };
}
