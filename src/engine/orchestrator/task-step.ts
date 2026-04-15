import type { Task, WorkflowState, TaskTokenUsage, TokenUsage } from '../../types.js';
import { formatValidationError } from './validator.js';

import type { WorkflowContext } from './types.js';
import { buildAndRecordUsage } from './tokens.js';
import { toErrorMessage, labelError } from '../../utils/format.js';
import { emit, createTextHandler, emitError, emitTaskStart } from './events.js';
import { handleRetryAndEscalation } from './escalation.js';
import { refreshAndPersistCode, addUsageAndSave, transitionAndSave, validateAndCommitTask } from './helpers.js';
import { getRunnerDisplayName } from '../../core/config/runner-config.js';
import { buildContinuationPrompt } from './continuation.js';
import { workflowStore } from '../../stores/workflow.js';

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
  const { projectDir, sessionId } = wctx;
  const { state, result } = await handleRetryAndEscalation({
    wctx, task, initialError, currentState: opts.state, taskStartTime,
  });
  setTrackedState(state);
  buildAndRecordUsage({ task, method: result.method, tokensBefore, currentUsage: state.tokenUsage, projectDir, sessionId, state, taskBreakdowns, retryCount: result.attempts, tool: getRunnerDisplayName(wctx.config.implementer), model: wctx.config.implementer.model });
  if (!result.completed) emit(projectDir, sessionId, state, 'task_failed', task.id, {});
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
  const { projectDir, sessionId, config, callbacks, context } = wctx;
  let state = opts.state;

  if (wctx.signal?.aborted) return state;

  state = transitionAndSave(projectDir, sessionId, state, { type: 'START_TASK', taskId: opts.task.id });
  setTrackedState(state);

  let task: Task;
  ({ task, state } = await refreshAndPersistCode(opts.task, projectDir, sessionId, state));
  setTrackedState(state);

  setCurrentTask(task);
  const taskStartTime = Date.now();
  emitTaskStart(callbacks, {
    taskId: task.id, title: task.title, index, total: totalTasks, file: task.file, action: task.action,
    tool: getRunnerDisplayName(config.implementer), model: config.implementer.model,
  });
  emit(projectDir, sessionId, state, 'task_started', task.id, {});

  const tokensBefore = { ...state.tokenUsage };

  if (wctx.signal?.aborted) return state;

  let partialOutput = '';
  let continuationPrompt: string | undefined;
  const textHandler = createTextHandler(callbacks);

  // Per-call abort + continuation loop
  let implResult: Awaited<ReturnType<typeof wctx.implementer.implement>> | undefined;
  while (true) {
    const callController = new AbortController();
    workflowStore.setAbortHandler(() => callController.abort());
    partialOutput = '';

    try {
      implResult = await wctx.implementer.implement({
        task, projectDir, config, context,
        onOutput: (text) => { partialOutput += text; textHandler(text); },
        onEvent: callbacks.onEvent,
        sessionId,
        signal: callController.signal,
        continuationPrompt,
      });
    } catch (err) {
      workflowStore.setAbortHandler(null);

      // Per-call abort (not workflow cancel): enter continuation mode
      if (callController.signal.aborted && !wctx.signal?.aborted && callbacks.onContinuationNeeded) {
        state = transitionAndSave(projectDir, sessionId, state, { type: 'ABORT_TURN' });
        setTrackedState(state);
        const userText = await callbacks.onContinuationNeeded(partialOutput);
        state = transitionAndSave(projectDir, sessionId, state, { type: 'CONTINUE_TURN' });
        setTrackedState(state);
        continuationPrompt = buildContinuationPrompt(partialOutput, userText);
        continue;
      }

      emitError(callbacks, labelError('Implementation failed', err));
      const retry = await retryAndRecord({
        wctx, task, initialError: toErrorMessage(err),
        state, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState,
      });
      return retry.state;
    }

    workflowStore.setAbortHandler(null);

    // Abort returned as a result (not thrown) — handle continuation
    if (callController.signal.aborted && !implResult.success && !wctx.signal?.aborted && callbacks.onContinuationNeeded) {
      state = transitionAndSave(projectDir, sessionId, state, { type: 'ABORT_TURN' });
      setTrackedState(state);
      const userText = await callbacks.onContinuationNeeded(partialOutput);
      state = transitionAndSave(projectDir, sessionId, state, { type: 'CONTINUE_TURN' });
      setTrackedState(state);
      continuationPrompt = buildContinuationPrompt(partialOutput, userText);
      continue;
    }

    break;
  }

  state = addUsageAndSave(projectDir, sessionId, state, 'implementer', implResult.usage, callbacks);
  setTrackedState(state);

  if (!implResult.success) {
    const retry = await retryAndRecord({
      wctx, task, initialError: implResult.error ?? 'Implementation failed to produce valid code',
      state, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState,
    });
    return retry.state;
  }

  state = transitionAndSave(projectDir, sessionId, state, { type: 'TASK_SENT' });
  setTrackedState(state);

  if (wctx.signal?.aborted) return state;

  const commitResult = await validateAndCommitTask({
    task, projectDir, sessionId, config, callbacks, state,
    method: 'local', transitionType: 'VALIDATION_PASS', taskStartTime,
  });
  if (commitResult.completed) {
    state = commitResult.state;
    setTrackedState(state);
    buildAndRecordUsage({ task, method: 'local', tokensBefore, currentUsage: state.tokenUsage, projectDir, sessionId, state, taskBreakdowns, tool: getRunnerDisplayName(config.implementer), model: config.implementer.model });
    return state;
  }

  const errorText = formatValidationError(commitResult.validationResults);
  const retry = await retryAndRecord({
    wctx, task, initialError: errorText,
    state, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState,
  });
  return retry.state;
}
