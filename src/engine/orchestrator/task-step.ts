import type { Task, WorkflowState, TaskTokenUsage, TokenUsage } from '../../types.js';
import { formatValidationError } from './validator.js';

import type { WorkflowContext } from './run.js';
import { buildAndRecordUsage } from './tokens.js';
import { toErrorMessage } from '../../utils/format.js';
import { emit, createTextHandler, emitError, emitTaskStart } from './events.js';
import { handleRetryAndEscalation } from './escalation.js';
import { refreshAndPersistCode, addUsageAndSave, transitionAndSave, validateAndCommitTask } from './helpers.js';

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
  const { state, result } = await handleRetryAndEscalation({
    wctx, task, initialError, currentState: opts.state, taskStartTime,
  });
  setTrackedState(state);
  buildAndRecordUsage({ task, method: result.method, tokensBefore, currentUsage: state.tokenUsage, projectDir, state, taskBreakdowns, retryCount: result.attempts });
  if (!result.completed) emit(projectDir, state, 'task_failed', task.id, {});
  return { state, completed: result.completed };
}

type RunSingleTaskOptions = {
  wctx: WorkflowContext;
  task: Task;
  index: number;
  totalTasks: number;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'action'> | undefined) => void;
};

export async function runSingleTask(opts: RunSingleTaskOptions): Promise<WorkflowState> {
  const { wctx, index, totalTasks, taskBreakdowns, setTrackedState, setCurrentTask } = opts;
  const { projectDir, config, callbacks, context } = wctx;
  let state = opts.state;

  state = transitionAndSave(projectDir, state, { type: 'START_TASK', taskId: opts.task.id });
  setTrackedState(state);

  let task: Task;
  ({ task, state } = await refreshAndPersistCode(opts.task, projectDir, state));
  setTrackedState(state);

  setCurrentTask(task);
  const taskStartTime = Date.now();
  emitTaskStart(callbacks, { taskId: task.id, title: task.title, index, total: totalTasks, file: task.file, action: task.action });
  emit(projectDir, state, 'task_started', task.id, {});

  const tokensBefore = { ...state.tokenUsage };

  let implResult: Awaited<ReturnType<typeof wctx.implementer.implement>>;
  try {
    implResult = await wctx.implementer.implement({
      task, projectDir, config, context,
      onOutput: createTextHandler(callbacks),
      onEvent: callbacks.onEvent,
    });
  } catch (err) {
    emitError(callbacks, `Implementation failed: ${toErrorMessage(err)}`);
    const retry = await retryAndRecord({
      wctx, task, initialError: toErrorMessage(err),
      state, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState,
    });
    return retry.state;
  }

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

  const commitResult = await validateAndCommitTask({
    task, projectDir, config, callbacks, state,
    method: 'local', transitionType: 'VALIDATION_PASS', taskStartTime,
  });
  if (commitResult.completed) {
    state = commitResult.state;
    setTrackedState(state);
    buildAndRecordUsage({ task, method: 'local', tokensBefore, currentUsage: state.tokenUsage, projectDir, state, taskBreakdowns });
    return state;
  }

  const errorText = formatValidationError(commitResult.validationResults);
  const retry = await retryAndRecord({
    wctx, task, initialError: errorText,
    state, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState,
  });
  return retry.state;
}
