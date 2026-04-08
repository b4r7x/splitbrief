import type { Task, WorkflowState, TaskTokenUsage, TokenUsage } from '../../types.js';
import { loadState } from '../../core/state/persistence.js';
import { validateTask, formatValidationError } from './validator.js';

import type { WorkflowContext } from './run.js';
import { tokenDelta } from './tokens.js';
import { emit, emitValidationStart, emitValidationProgress, emitValidationResult, createTextHandler } from './events.js';
import { validateCommitAndAdvance } from './task-runner.js';
import { handleRetryAndEscalation } from './escalation.js';
import { refreshCurrentCode, addUsageAndSave, transitionAndSave } from './helpers.js';

export function emitTaskTokens(projectDir: string, state: WorkflowState, taskId: string, usage: TaskTokenUsage): void {
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

export function buildAndRecordUsage(opts: BuildAndRecordUsageOptions): void {
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

export async function retryAndRecord(opts: RetryAndRecordOptions): Promise<{ state: WorkflowState; completed: boolean }> {
  const { wctx, task, initialError, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState } = opts;
  const { projectDir } = wctx;
  const retryResult = await handleRetryAndEscalation({
    wctx, task, initialError, currentState: opts.state, taskStartTime,
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

export async function runSingleTask(opts: RunSingleTaskOptions): Promise<WorkflowState> {
  const { wctx, task, index, totalTasks, taskBreakdowns, setTrackedState, setCurrentTask } = opts;
  const { projectDir, config, callbacks, context } = wctx;
  let state = opts.state;

  task.status = 'in_progress';
  setCurrentTask(task);
  const taskStartTime = Date.now();
  callbacks.onEvent({ type: 'task-start', ts: taskStartTime, taskId: task.id, title: task.title, index, total: totalTasks, file: task.file, action: task.action });
  emit(projectDir, state, 'task_started', task.id);

  refreshCurrentCode(task, projectDir);

  const tokensBefore = { ...state.tokenUsage };

  const implResult = await wctx.implementer.implement({
    task, projectDir, config, context,
    onProgress: createTextHandler(callbacks),
    onEvent: callbacks.onEvent,
  });

  state = addUsageAndSave(projectDir, state, 'implementer', implResult.usage, callbacks);
  setTrackedState(state);

  if (!implResult.success) {
    const retry = await retryAndRecord({
      wctx, task, initialError: implResult.error ?? 'Implementation failed to produce valid code',
      state, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState,
    });
    return retry.state;
  }

  state = transitionAndSave(projectDir, state, { type: 'TASK_SENT' });
  setTrackedState(state);

  const valStartTime = Date.now();
  emitValidationStart(callbacks);
  const validationResults = await validateTask(task, projectDir, config, (stages) => {
    emitValidationProgress(callbacks, stages, valStartTime);
  });
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
