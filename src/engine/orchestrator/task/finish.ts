import type { Task } from '../../../core/schemas/task.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import type { BriefExecution } from '../../../core/schemas/brief-execution.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import {
  type ChangedFilesBaseline,
  inferTaskOwnChangedFiles,
  refreshChangedFilesBaseline,
  serializeChangedFilesBaseline,
  withActiveTaskSnapshot,
} from '../changed-files-baseline.js';
import { commitWorkflowState } from '../state-ops/commit.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { stateOpsError } from '../state-ops/errors.js';
import type { BoundaryPark, WorkflowContext } from '../types.js';
import { runScheduledReview } from '../review/loop/scheduled.js';
import { recordCheckoutRunSnapshot } from '../run/snapshots.js';

export function withBaseline(state: WorkflowState, baseline: ChangedFilesBaseline): WorkflowState {
  return { ...state, changedFilesBaseline: serializeChangedFilesBaseline(baseline) };
}

/**
 * The task loop holds its state across awaits; a head saved meanwhile (a queued message) wins and
 * the loop's own fields go on top of it.
 */
export function commitOnHead(
  ref: SessionRef,
  current: WorkflowState,
  apply: (head: WorkflowState) => WorkflowState,
  setTrackedState: (s: WorkflowState) => void,
): WorkflowState {
  const head = rebaseOnPersistedWorkflowState(ref, current, { keepUnsaved: true });
  const committed = commitWorkflowState({ ref, expected: head, next: apply(head) });
  if (committed.kind === 'conflict') throw stateOpsError.changedOnDisk(ref.sessionId);
  if (committed.kind === 'durability-uncertain') {
    throw stateOpsError.durabilityUncertain(ref.sessionId);
  }
  setTrackedState(committed.state);
  return committed.state;
}

async function absorbAcceptedFiles(opts: {
  projectDir: string;
  sessionId: string;
  baseline: ChangedFilesBaseline;
  completedTask: Task | undefined;
  refreshedTask: Task;
  taskAcceptedFiles: Set<string>;
}): Promise<ChangedFilesBaseline> {
  const { projectDir, completedTask, refreshedTask, taskAcceptedFiles } = opts;
  if (
    completedTask !== undefined &&
    isTaskCompleted(completedTask.status) &&
    taskAcceptedFiles.size === 0
  ) {
    for (const file of await inferTaskOwnChangedFiles(
      { projectDir, sessionId: opts.sessionId },
      refreshedTask,
      opts.baseline.head,
      projectDir,
    ))
      taskAcceptedFiles.add(file);
  }
  const refreshed = await refreshChangedFilesBaseline({
    projectDir,
    baseline: opts.baseline,
    absorbedFiles: taskAcceptedFiles,
  });
  // A brief stopped in flight keeps its task-start snapshot: its continuation compares against it.
  const active = opts.baseline.activeTaskSnapshot;
  return completedTask?.status === 'in_progress' && active !== undefined
    ? withActiveTaskSnapshot(refreshed, active)
    : refreshed;
}

/**
 * The work after a brief: its files go into the changed-files baseline, its files and usage are
 * saved, and its checkout snapshot is recorded. Then a stop, a task review that stops the run, or
 * a pause asked for meanwhile ends the loop.
 */
export async function finishTask(input: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  baseline: ChangedFilesBaseline;
  taskIndex: number;
  refreshedTask: Task;
  taskAcceptedFiles: Set<string>;
  taskBreakdowns: readonly BriefExecution[];
}): Promise<{
  state: WorkflowState;
  baseline: ChangedFilesBaseline;
  exit?: { status: 'stopped' } | { status: 'paused'; park: BoundaryPark } | undefined;
}> {
  const { wctx, setTrackedState, taskIndex } = input;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  let baseline = input.baseline;
  const activeTaskSnapshot = input.state.changedFilesBaseline?.activeTaskSnapshot;
  if (activeTaskSnapshot !== undefined) {
    baseline = withActiveTaskSnapshot(baseline, activeTaskSnapshot);
  }
  const completedTask = input.state.tasks[taskIndex];
  baseline = await absorbAcceptedFiles({
    ...ref,
    baseline,
    completedTask,
    refreshedTask: input.refreshedTask,
    taskAcceptedFiles: input.taskAcceptedFiles,
  });
  // A stop at this boundary parks from the persisted head, which would otherwise lack this
  // brief's files and execution record.
  let state = commitOnHead(
    ref,
    input.state,
    (head) => withBaseline({ ...head, taskBreakdowns: [...input.taskBreakdowns] }, baseline),
    setTrackedState,
  );
  await recordCheckoutRunSnapshot({ ...ref, bus: wctx.bus, state });

  if (wctx.signal?.aborted || state.currentTaskIndex <= taskIndex) {
    return { state, baseline, exit: { status: 'stopped' } };
  }

  // The configured cadence: with workflow.review 'task' every brief that passed its
  // validation is reviewed before the loop moves on; a failing review's fix tasks are
  // appended and the re-read bound runs them.
  if (resolveReviewCadence(wctx.config) === 'task') {
    const scheduled = await runScheduledReview({
      wctx,
      state,
      setTrackedState,
      callbacks: wctx.callbacks,
      ...(completedTask !== undefined && { afterTaskId: completedTask.id }),
    });
    state = scheduled.state;
    if (scheduled.status === 'stopped') return { state, baseline, exit: { status: 'stopped' } };
  }

  const park = wctx.sinks.consumeBoundaryPause?.();
  return park === undefined
    ? { state, baseline }
    : { state, baseline, exit: { status: 'paused', park } };
}
