import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { BriefExecution } from '../../../core/schemas/brief-execution.js';
import type { WorkflowContext } from '../types.js';
import { isAbortError } from '../../../utils/abort.js';
import { publishTaskValidating } from '../publish/task.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { refreshAndPersistCode } from './refresh-code.js';
import { acceptLocalAttempt } from './commit.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import { gateTaskAttempt } from './gates/attempt.js';
import { retryAndRecord, consultHandedBackToLoop, continueLadder } from './retry.js';
import { recordSteerCorrection } from '../queue/build-corrections.js';
import { runPreTaskHooksAndPublish } from './start.js';
import { runImplementationStep } from './implementation-result.js';
import { runBriefGate } from './gates/brief.js';
import { recordRoutedBrief } from './record-settlement.js';

type RunSingleTaskOptions = {
  wctx: WorkflowContext;
  task: Task;
  taskCodeRefreshed?: boolean;
  index: number;
  totalTasks: number;
  state: WorkflowState;
  taskBreakdowns: BriefExecution[];
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'suggestedFiles' | 'action'> | undefined) => void;
  onTaskStartSnapshot?:
    | ((state: WorkflowState, snapshot: ChangedFilesSnapshot) => WorkflowState)
    | undefined;
  onTaskAcceptedFiles?: ((files: string[]) => void) | undefined;
};

/**
 * The state the ladder of `task` handed back. When a consult replaced or split the brief, the run
 * re-enters the task loop at the current index, which now holds the rewritten task or the split's
 * first child. The state was reset to `implementing` by the retry record, so the brief runs like
 * any other from here.
 */
async function rerunReplacedTask(
  opts: RunSingleTaskOptions,
  state: WorkflowState,
  task: Task,
): Promise<WorkflowState> {
  if (!consultHandedBackToLoop(state, task)) return state;
  const index = state.currentTaskIndex;
  const current = state.tasks[index];
  if (current === undefined) return state;
  return runSingleTask({
    ...opts,
    task: current,
    taskCodeRefreshed: false,
    index,
    totalTasks: state.tasks.length,
    state,
  });
}

export async function runSingleTask(opts: RunSingleTaskOptions): Promise<WorkflowState> {
  const { wctx, index, totalTasks, taskBreakdowns, setTrackedState, setCurrentTask } = opts;
  const { projectDir, sessionId } = wctx;
  let state = opts.state;

  if (state.pendingRecovery || wctx.signal?.aborted) return state;

  state = transitionAndSave({ projectDir, sessionId }, state, {
    type: 'START_TASK',
    taskId: opts.task.id,
  });
  setTrackedState(state);

  let task = opts.task;
  if (!opts.taskCodeRefreshed) {
    ({ task, state } = await refreshAndPersistCode(
      opts.task,
      wctx,
      state,
      wctx.workspaceDir,
      'dispatch',
    ));
    setTrackedState(state);
  }

  setCurrentTask(task);

  const preTaskResult = await runPreTaskHooksAndPublish({
    wctx,
    task,
    state,
    index,
    totalTasks,
    setTrackedState,
  });
  if (!preTaskResult.proceed) return preTaskResult.state;
  state = preTaskResult.state;
  const taskStartSnapshot = preTaskResult.taskStartSnapshot;
  if (opts.onTaskStartSnapshot !== undefined) {
    state = opts.onTaskStartSnapshot(state, taskStartSnapshot);
  }
  // After its task-start snapshot: a Try again of this revision runs on its own files.
  state = transitionAndSave(wctx, state, { type: 'RECORD_DISPATCH', taskId: task.id });
  setTrackedState(state);

  if (wctx.signal?.aborted) return state;

  // A brief parked at its consult runs that consult again, on the files its ended attempt left: it
  // asks the question it was asked, and it reads the words typed to continue as a correction.
  const parked = wctx.continuation?.takeConsult(task.id);
  if (parked !== undefined) {
    if (parked.steer !== undefined) {
      state = recordSteerCorrection({ ...wctx, state, taskId: task.id, message: parked.steer });
      setTrackedState(state);
    }
    const retry = await continueLadder({
      wctx,
      task,
      initialError: parked.question.failingOutput,
      initialBlocked: parked.question.report,
      unfinishedCalls: parked.question.unfinishedCalls,
      state,
      taskStartSnapshot,
      taskBreakdowns,
      setTrackedState,
    });
    return rerunReplacedTask(opts, retry.state, task);
  }

  const implemented = await runImplementationStep({
    wctx,
    task,
    state,
    taskStartSnapshot,
    taskBreakdowns,
    setTrackedState,
  });
  if (implemented.outcome === 'stopped') return implemented.state;
  if (implemented.outcome === 'failed') return rerunReplacedTask(opts, implemented.state, task);
  state = implemented.state;
  const { implState } = implemented;

  const gateStop = await gateTaskAttempt({
    wctx,
    task,
    state,
    workspace: implState.workspace,
    preApprovedFiles: implState.preApplyApprovedFiles,
    setTrackedState,
  });
  if (gateStop !== undefined) return gateStop;

  const taskChangedFiles = await getChangedFilesSinceSnapshot(wctx.workspaceDir, taskStartSnapshot);

  const report = implState.implResult.report;
  if (report?.status === 'done') {
    state = transitionAndSave(wctx, state, {
      type: 'RECORD_DECISIONS',
      taskId: task.id,
      decisions: report.decisions,
    });
    setTrackedState(state);
  }

  state = transitionAndSave({ projectDir, sessionId }, state, { type: 'TASK_SENT' });
  setTrackedState(state);
  publishTaskValidating({ bus: wctx.bus, phase: state.phase }, task.id);

  if (wctx.signal?.aborted) return state;

  let gated: Awaited<ReturnType<typeof runBriefGate>>;
  try {
    gated = await runBriefGate({
      wctx,
      state,
      task,
      changedFiles: taskChangedFiles,
      taskStartSnapshot,
      attemptSnapshot: implState.workspace.snapshot,
      setTrackedState,
    });
  } catch (err) {
    if (isAbortError(err) || wctx.signal?.aborted) return state;
    throw err;
  }
  state = gated.state;
  if (gated.stop === 'skipped') {
    recordRoutedBrief({ wctx, state, task, taskBreakdowns, method: 'skipped' });
  }
  if (gated.stop !== undefined) return state;
  const { acceptance } = gated;

  if (!gated.correction) {
    const accepted = await acceptLocalAttempt({
      wctx,
      task,
      state,
      taskStartSnapshot,
      acceptance,
      taskChangedFiles,
      applyResult: implState.implResult.applyResult,
      taskBreakdowns,
      setTrackedState,
      onTaskAcceptedFiles: opts.onTaskAcceptedFiles,
    });
    if (accepted !== undefined) return accepted;
  }

  if (wctx.signal?.aborted) return state;

  if (gated.correction) {
    state = transitionAndSave(wctx, state, { type: 'RESUME_TASK' });
    setTrackedState(state);
  }
  const retry = await retryAndRecord({
    wctx,
    task,
    initialError: gated.error,
    ...(gated.correction && { initialAnswer: gated.error }),
    state,
    taskStartSnapshot,
    taskBreakdowns,
    setTrackedState,
    initialChangedFiles: taskChangedFiles,
  });
  return rerunReplacedTask(opts, retry.state, task);
}
