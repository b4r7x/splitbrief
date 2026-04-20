import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskTokenUsage, TokenUsage } from '../../core/schemas/tokens.js';
import { formatValidationError } from './validation.js';

import type { WorkflowContext } from './types.js';
import { recordTaskUsage } from './tokens.js';
import { toErrorMessage, labelError } from '../../utils/format-errors.js';
import { createBusTextHandler, publishError, publishEvent, publishTaskStart, publishTaskSkipped, publishWarning } from './events.js';
import { runPreHooks } from '../hooks/run-pre-hook.js';
import { handleRetryAndEscalation } from './escalation/escalation.js';
import { refreshAndPersistCode, addUsageAndSave, transitionAndSave } from './state-ops.js';
import { validateCommitAndAdvance } from './task-commit.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';
import { withContinuationLoop } from './continuation.js';

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
  const { state, result } = await handleRetryAndEscalation({
    wctx, task, initialError, currentState: opts.state, taskStartTime,
  });
  setTrackedState(state);
  recordTaskUsage({ task, method: result.method, tokensBefore, currentUsage: state.tokenUsage, bus: wctx.bus, state, taskBreakdowns, retryCount: result.attempts, tool: getRunnerDisplayName(wctx.config.implementer), model: wctx.config.implementer.model });
  if (!result.completed) publishEvent(wctx.bus, { type: 'task_failed', ts: Date.now(), phase: state.phase, taskId: task.id });
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

  if (wctx.config.hooks) {
    const preTaskPayload: import('../events/types.js').EngineEvent = {
      type: 'task_started', ts: Date.now(), phase: state.phase,
      taskId: opts.task.id, title: opts.task.title, index, total: totalTasks,
      file: opts.task.file, action: opts.task.action,
    };
    const pre = await runPreHooks(wctx.config.hooks, 'pre_task', preTaskPayload, { projectDir, sessionId });
    if (!pre.allow) {
      publishWarning(wctx.bus, state.phase, `pre_task blocked: ${pre.reason ?? 'hook denied'}`);
      publishTaskSkipped(wctx.bus, state.phase, { taskId: opts.task.id, title: opts.task.title, reason: pre.reason ?? 'pre_task hook denied' });
      state = transitionAndSave(projectDir, sessionId, state, { type: 'SKIP_TASK', taskId: opts.task.id });
      setTrackedState(state);
      return state;
    }
  }

  state = transitionAndSave(projectDir, sessionId, state, { type: 'START_TASK', taskId: opts.task.id });
  setTrackedState(state);

  let task: Task;
  ({ task, state } = await refreshAndPersistCode(opts.task, projectDir, sessionId, state));
  setTrackedState(state);

  setCurrentTask(task);
  const taskStartTime = Date.now();
  publishTaskStart(wctx.bus, state.phase, {
    taskId: task.id, title: task.title, index, total: totalTasks, file: task.file, action: task.action,
    tool: getRunnerDisplayName(config.implementer), model: config.implementer.model,
  });

  const tokensBefore = { ...state.tokenUsage };

  if (wctx.signal?.aborted) return state;

  const textHandler = createBusTextHandler(wctx.bus, state.phase);

  type ImplResult = Awaited<ReturnType<typeof wctx.implementer.implement>>;
  let implResult: ImplResult;
  try {
    const loop = await withContinuationLoop<ImplResult>({
      ctx: { projectDir, sessionId, callbacks, signal: wctx.signal, sinks: wctx.sinks },
      state,
      onStateChange: setTrackedState,
      body: async ({ signal, continuationPrompt, recordOutput }) => {
        const result = await wctx.implementer.implement({
          task, projectDir, config, context,
          onOutput: (text) => { recordOutput(text); textHandler(text); },
          sessionId,
          signal,
          continuationPrompt,
          bus: wctx.bus,
          phase: state.phase,
        });
        return { value: result, continueIfAborted: !result.success };
      },
    });
    state = loop.state;
    implResult = loop.value;
  } catch (err) {
    publishError(wctx.bus, state.phase, labelError('Implementation failed', err));
    const retry = await retryAndRecord({
      wctx, task, initialError: toErrorMessage(err),
      state, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState,
    });
    return retry.state;
  }

  state = addUsageAndSave(projectDir, sessionId, state, 'implementer', implResult.usage, wctx.bus);
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

  if (wctx.config.hooks) {
    const preValidationPayload: import('../events/types.js').EngineEvent = {
      type: 'validate', ts: Date.now(), phase: state.phase,
      taskId: task.id, status: 'running', passed: false,
      stages: { tsc: false, lint: false, test: false },
    };
    const preVal = await runPreHooks(wctx.config.hooks, 'pre_validation', preValidationPayload, { projectDir, sessionId });
    if (!preVal.allow) {
      publishWarning(wctx.bus, state.phase, `pre_validation blocked: ${preVal.reason ?? 'hook denied'}`);
      return state;
    }
  }

  const validationResults = await wctx.validator.runValidation(task, projectDir, config, wctx.bus, state.phase, task.id);
  const commitResult = await validateCommitAndAdvance({
    task, projectDir, sessionId, config, bus: wctx.bus, state,
    method: 'local', transitionType: 'VALIDATION_PASS', taskStartTime,
    results: validationResults,
  });
  if (commitResult.completed) {
    state = commitResult.state;
    setTrackedState(state);
    recordTaskUsage({ task, method: 'local', tokensBefore, currentUsage: state.tokenUsage, bus: wctx.bus, state, taskBreakdowns, tool: getRunnerDisplayName(config.implementer), model: config.implementer.model });
    return state;
  }

  const errorText = formatValidationError(validationResults);
  const retry = await retryAndRecord({
    wctx, task, initialError: errorText,
    state, taskStartTime, tokensBefore, taskBreakdowns, setTrackedState,
  });
  return retry.state;
}
