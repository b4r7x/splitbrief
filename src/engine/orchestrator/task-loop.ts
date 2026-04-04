import type { Task, WorkflowState, OrchestratorCallbacks, TaskTokenUsage, TokenUsage } from '../../types.js';
import { transition } from '../../core/state.js';
import { saveState, loadState } from '../../core/state-persistence.js';
import { validateTask, formatValidationError } from '../validator.js';
import { hasExternalChanges } from '../../utils/git.js';

import type { WorkflowContext } from './types.js';
import { tokenDelta } from './tokens.js';
import { emit, emitValidationStart, emitValidationResult, createTextHandler } from './events.js';
import { validateCommitAndAdvance } from './task-runner.js';
import { handleRetryAndEscalation } from './escalation.js';
import { refreshCurrentCode, addUsageAndSave } from './helpers.js';

function markTask(task: Task, status: Task['status']): void {
  task.status = status;
}

export function hasDependencyFailed(task: Task, failedTasks: string[], skippedTasks: string[]): boolean {
  const blocked = new Set([...failedTasks, ...skippedTasks]);
  return task.dependsOn.some((dep) => blocked.has(dep));
}

function emitTaskTokens(projectDir: string, state: WorkflowState, taskId: string, usage: TaskTokenUsage): void {
  emit(projectDir, state, 'task_tokens', taskId, {
    method: usage.method, implementerTokens: usage.implementerTokens,
    escalationTokens: usage.escalationTokens, retryCount: usage.retryCount,
  });
}

type BuildAndRecordUsageOptions = {
  task: Task;
  method: TaskTokenUsage['method'];
  tokensBefore: TokenUsage;
  currentUsage: TokenUsage;
  projectDir: string;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  retryCount?: number;
};

function buildAndRecordUsage(opts: BuildAndRecordUsageOptions): void {
  const { task, method, tokensBefore, currentUsage, projectDir, state, taskBreakdowns, retryCount } = opts;
  const delta = tokenDelta(tokensBefore, currentUsage);
  const usage: TaskTokenUsage = {
    taskId: task.id, taskTitle: task.title, method,
    implementerTokens: delta.implementerTokens, escalationTokens: delta.escalationTokens,
    retryCount: retryCount ?? 0,
  };
  taskBreakdowns.push(usage);
  emitTaskTokens(projectDir, state, task.id, usage);
}

async function checkExternalChanges(
  projectDir: string, callbacks: OrchestratorCallbacks, state: WorkflowState, taskId: string,
): Promise<WorkflowState | null> {
  try {
    const externalChanges = await hasExternalChanges(projectDir);
    if (externalChanges) {
      const proceed = await callbacks.onExternalChanges();
      if (!proceed) {
        emit(projectDir, state, 'paused_external_changes', taskId);
        const cancelled = transition(state, { type: 'CANCEL' });
        saveState(projectDir, cancelled);
        return cancelled;
      }
    }
  } catch {
    // Not a git repo or git error - continue anyway
  }
  return null;
}

type HandleSkippedTaskOptions = {
  task: Task;
  state: WorkflowState;
  projectDir: string;
  callbacks: OrchestratorCallbacks;
  taskBreakdowns: TaskTokenUsage[];
  index: number;
};

function handleSkippedTask(opts: HandleSkippedTaskOptions): WorkflowState {
  const { task, projectDir, callbacks, taskBreakdowns, index } = opts;
  markTask(task, 'skipped');
  const state = {
    ...opts.state,
    skippedTasks: [...opts.state.skippedTasks, task.id],
    currentTaskIndex: index + 1,
  };
  const skipReason = `dependency failed: ${task.dependsOn.filter((d) => state.failedTasks.includes(d) || state.skippedTasks.includes(d)).join(', ')}`;
  callbacks.onEvent({ type: 'task-skipped', ts: Date.now(), taskId: task.id, title: task.title, reason: skipReason });
  emit(projectDir, state, 'task_skipped', task.id);
  const usage: TaskTokenUsage = { taskId: task.id, taskTitle: task.title, method: 'skipped', implementerTokens: 0, escalationTokens: 0, retryCount: 0 };
  taskBreakdowns.push(usage);
  emitTaskTokens(projectDir, state, task.id, usage);
  saveState(projectDir, state);
  return state;
}

type RetryAndRecordOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  state: WorkflowState;
  taskStartTime: number;
  tokensBefore: TokenUsage;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
};

async function retryAndRecord(opts: RetryAndRecordOptions): Promise<{ state: WorkflowState; completed: boolean }> {
  const { wctx, task, initialError, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState } = opts;
  const { projectDir, config, callbacks, planner, context, implementer } = wctx;
  const retryResult = await handleRetryAndEscalation({
    task, initialError, projectDir, config, context, planner, callbacks,
    currentState: opts.state, taskStartTime, implementer,
  });
  const state = loadState(projectDir) ?? opts.state;
  setTrackedState(state);
  buildAndRecordUsage({ task, method: retryResult.method, tokensBefore, currentUsage: state.tokenUsage, projectDir, state, taskBreakdowns, retryCount: state.attempt });
  if (!retryResult.completed) emit(projectDir, state, 'task_failed', task.id);
  return { state, completed: retryResult.completed };
}

type RunSingleTaskOptions = {
  wctx: WorkflowContext;
  task: Task;
  index: number;
  totalTasks: number;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: { file: string; action: string } | undefined) => void;
};

async function runSingleTask(opts: RunSingleTaskOptions): Promise<WorkflowState> {
  const { wctx, task, index, totalTasks, taskBreakdowns, setTrackedState, setCurrentTask } = opts;
  const { projectDir, config, callbacks, context } = wctx;
  let state = opts.state;

  markTask(task, 'in_progress');
  setCurrentTask(task);
  const taskStartTime = Date.now();
  callbacks.onEvent({ type: 'task-start', ts: taskStartTime, taskId: task.id, title: task.title, index, total: totalTasks, file: task.file, action: task.action });
  emit(projectDir, state, 'task_started', task.id);

  if (task.action === 'modify') {
    refreshCurrentCode(task, projectDir);
  }

  const tokensBefore = { ...state.tokenUsage };

  const implResult = await wctx.implementer.implement({
    task, projectDir, config, context,
    onProgress: createTextHandler(callbacks),
    onEvent: callbacks.onEvent,
  });

  state = addUsageAndSave(projectDir, state, 'implementer', implResult.usage);

  if (!implResult.success) {
    const retry = await retryAndRecord({
      wctx, task, initialError: implResult.error ?? 'Implementation failed to produce valid code',
      state, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState,
    });
    return retry.state;
  }

  state = transition(state, { type: 'TASK_SENT' });
  saveState(projectDir, state);

  const valStartTime = Date.now();
  emitValidationStart(callbacks);
  const validationResults = await validateTask(task, projectDir, config);
  emitValidationResult(callbacks, validationResults, valStartTime);

  const commitResult = await validateCommitAndAdvance({
    task, results: validationResults, projectDir, config, state, callbacks,
    method: 'local', transitionType: 'VALIDATION_PASS', taskStartTime,
  });
  if (commitResult.completed) {
    state = commitResult.state;
    setTrackedState(state);
    buildAndRecordUsage({ task, method: 'local', tokensBefore, currentUsage: state.tokenUsage, projectDir, state, taskBreakdowns });
    return state;
  }

  const errorText = formatValidationError(validationResults);
  const retry = await retryAndRecord({
    wctx, task, initialError: errorText,
    state, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState,
  });
  return retry.state;
}

type RunTaskLoopOptions = {
  wctx: WorkflowContext;
  initialState: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: { file: string; action: string } | undefined) => void;
};

export async function runTaskLoop(opts: RunTaskLoopOptions): Promise<{ state: WorkflowState; taskBreakdowns: TaskTokenUsage[] }> {
  const { wctx, setTrackedState, setCurrentTask } = opts;
  const { projectDir, callbacks } = wctx;
  let state = opts.initialState;
  const totalTasks = state.tasks.length;
  const taskBreakdowns: TaskTokenUsage[] = [];

  for (let i = state.currentTaskIndex; i < totalTasks; i++) {
    const task = state.tasks[i];

    const cancelledState = await checkExternalChanges(projectDir, callbacks, state, task.id);
    if (cancelledState) return { state: cancelledState, taskBreakdowns };

    if (hasDependencyFailed(task, state.failedTasks, state.skippedTasks)) {
      state = handleSkippedTask({ task, state, projectDir, callbacks, taskBreakdowns, index: i });
      continue;
    }

    state = await runSingleTask({ wctx, task, index: i, totalTasks, state, taskBreakdowns, setTrackedState, setCurrentTask });
  }
  setCurrentTask(undefined);

  return { state, taskBreakdowns };
}
