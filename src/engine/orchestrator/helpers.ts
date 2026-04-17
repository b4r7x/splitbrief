import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Task, WorkflowState, StateAction } from '../../core/types/state-actions.js';
import type { TokenDelta } from '../../core/types/summary.js';
import type { OrchestratorCallbacks, OrchestratorEventPayloadMap } from '../../core/types/events.js';
import { labelError } from '../../utils/format-errors.js';
import { isENOENT } from '../../utils/process-errors.js';
import { transition } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { writeSpecFile, type SpecMetadata } from '../../core/paths-io.js';
import { SPEC_FILE, PLAN_FILE, TASKS_FILE, REVIEW_FILE } from '../../core/paths.js';
import { addUsage, type UsageCategory } from './tokens.js';
import { createTextHandler, emitWarning, emitCostUpdate, emit, emitPlannerStatus } from './events.js';
import type { Planner } from '../planners/types.js';
import { buildResumeContext } from './transcript-rebuild.js';
import type { ResumeContextHolder } from './types.js';
import type { Config } from '../../core/types/config-options.js';

export function transitionAndSave(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  action: StateAction,
  maxRetries?: number,
): WorkflowState {
  const next = transition(state, action, maxRetries);
  saveState(projectDir, sessionId, next);
  return next;
}

async function refreshCurrentCode(task: Task, projectDir: string): Promise<Task> {
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
  task: Task, projectDir: string, sessionId: string, state: WorkflowState,
): Promise<{ task: Task; state: WorkflowState }> {
  const refreshed = await refreshCurrentCode(task, projectDir);
  if (refreshed.currentCode !== undefined) {
    state = transitionAndSave(projectDir, sessionId, state, { type: 'UPDATE_TASK_CODE', taskId: refreshed.id, code: refreshed.currentCode });
  }
  return { task: refreshed, state };
}

export function addUsageAndSave(
  projectDir: string, sessionId: string, state: WorkflowState, category: UsageCategory, usage: TokenDelta | null | undefined,
  callbacks: OrchestratorCallbacks,
): WorkflowState {
  const next = addUsage(state, category, usage);
  saveState(projectDir, sessionId, next);
  if (usage) {
    emitCostUpdate(callbacks, next.tokenUsage);
  }
  return next;
}

type RunPlannerReviewOptions = {
  planner: Planner;
  prompt: string;
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  state: WorkflowState;
  metadata?: SpecMetadata | null | undefined;
  writeTo?: typeof SPEC_FILE | typeof PLAN_FILE | typeof TASKS_FILE | typeof REVIEW_FILE;
};

export async function runPlannerReview(
  opts: RunPlannerReviewOptions,
): Promise<{ state: WorkflowState; text: string }> {
  const { planner, prompt, projectDir, sessionId, callbacks, writeTo, metadata } = opts;
  const result = await planner.review(prompt, projectDir, {
    onOutput: createTextHandler(callbacks),
  });
  const state = addUsageAndSave(projectDir, sessionId, opts.state, 'planner', result.usage, callbacks);
  if (writeTo) writeSpecFile(projectDir, sessionId, writeTo, result.text, metadata);
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

export type TransitionAndEmitOptions = {
  state: WorkflowState;
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  action: StateAction;
  eventName: keyof OrchestratorEventPayloadMap;
  status?: 'running' | 'done' | undefined;
  emitData: OrchestratorEventPayloadMap[keyof OrchestratorEventPayloadMap];
};

export function transitionAndEmit(opts: TransitionAndEmitOptions): WorkflowState {
  const { state, projectDir, sessionId, callbacks, action, eventName, status, emitData } = opts;
  const next = transitionAndSave(projectDir, sessionId, state, action);
  if (status) emitPlannerStatus(callbacks, next, status);
  emit(projectDir, sessionId, next, eventName, undefined, emitData);
  return next;
}

export type ApplyRebuiltContextOpts = {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  config: Pick<Config, 'workflow'>;
  resumeHolder: ResumeContextHolder | undefined;
  /** Whether to only populate resumeHolder when rebuilt.messages is non-empty (initial bootstrap). */
  requireNonEmpty?: boolean | undefined;
};

/**
 * Rebuild transcript context from disk and either populate the shared resumeHolder with prior
 * messages or emit a fallback warning when no transcript is persisted. Shared between the
 * mid-run `onSessionExpired` handler and the initial-bootstrap flow in run.ts.
 */
export async function applyRebuiltContext(opts: ApplyRebuiltContextOpts): Promise<void> {
  const { projectDir, sessionId, callbacks, config, resumeHolder, requireNonEmpty } = opts;
  const rebuilt = await buildResumeContext(projectDir, sessionId, config.workflow.persistTranscript !== false);
  if (rebuilt.warning === 'transcript-unavailable') {
    emitWarning(callbacks, 'Previous planner conversation expired and no transcript was persisted. Continuing with spec.md/plan.md/tasks.md only — the planner may regenerate differently.');
    return;
  }
  if (!resumeHolder) return;
  if (requireNonEmpty && rebuilt.messages.length === 0) return;
  resumeHolder.messages = rebuilt.messages;
}

export type SessionExpiredHandlerOpts = {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  config: Pick<Config, 'workflow'>;
  resumeHolder: ResumeContextHolder | undefined;
};

/**
 * Returns an async handler to pass as `onSessionExpired` to a planner call. The handler emits
 * a "rebuilding" warning, rebuilds the transcript context from disk, and populates the shared
 * resumeHolder so the next planner invocation re-injects prior messages. When no transcript is
 * persisted, emits a fallback warning instead.
 */
export function createSessionExpiredHandler(opts: SessionExpiredHandlerOpts): () => Promise<void> {
  return async () => {
    emitWarning(opts.callbacks, 'Previous planner conversation expired — rebuilding context from transcript.');
    await applyRebuiltContext(opts);
  };
}

