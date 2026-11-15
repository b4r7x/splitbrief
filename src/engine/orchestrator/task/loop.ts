import { isTaskSettled, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { BoundaryPark, WorkflowContext } from '../types.js';
import { runSingleTask } from './step.js';
import { refreshAndPersistCode } from './refresh-code.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import {
  captureChangedFilesBaseline,
  deserializeChangedFilesBaseline,
  unreadableChangedFiles,
  withActiveTaskSnapshot,
  type ChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { publishWarning } from '../publish/notice.js';
import { publishTasksPlanned } from '../publish/task.js';
import { checkDependencyGate } from './gates/dependency.js';
import { setupTaskImplementer } from './implementer-setup.js';
import { commitOnHead, finishTask, withBaseline } from './post-task.js';
import { runScheduledReview } from '../review/loop/scheduled.js';

type RunTaskLoopOptions = {
  wctx: WorkflowContext;
  initialState: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'suggestedFiles' | 'action'> | undefined) => void;
};

export type TaskLoopResult = { state: WorkflowState } & (
  | { status: 'complete' | 'stopped' }
  | { status: 'paused'; park: BoundaryPark }
);

export async function runTaskLoop(opts: RunTaskLoopOptions): Promise<TaskLoopResult> {
  const { wctx, setTrackedState, setCurrentTask } = opts;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  let state = opts.initialState;
  // Seed from persisted breakdowns so re-entry (resume / rewind / detached retry)
  // keeps per-task cost identity for already-completed tasks (F-454).
  const taskBreakdowns: TaskTokenUsage[] = [...(state.taskBreakdowns ?? [])];
  const resolvedProfiles = resolveImplementerProfiles(wctx.config);
  if (state.pendingRecovery) {
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message:
        'The run still waits at its halt, so the brief did not start. Choose an action in the halt panel.',
      safety: { category: 'recovery', code: 'recovery_pending_unresolved' },
    });
    return { state, status: 'stopped' };
  }
  if (state.pendingScheduledReview !== undefined) {
    const pending = await runScheduledReview({
      wctx,
      state,
      setTrackedState,
      callbacks: wctx.callbacks,
    });
    state = pending.state;
    if (pending.status === 'stopped') return { state, status: 'stopped' };
  }
  let changedFilesBaseline: ChangedFilesBaseline =
    state.changedFilesBaseline !== undefined
      ? deserializeChangedFilesBaseline(state.changedFilesBaseline)
      : await captureChangedFilesBaseline(wctx.workspaceDir);
  const unreadableFiles = unreadableChangedFiles(changedFilesBaseline);
  if (unreadableFiles.length > 0) {
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message: `Ignoring changed files that could not be read: ${unreadableFiles.join(', ')}.`,
      safety: { category: 'user-edit', code: 'unreadable_changed_files' },
    });
  }
  // Republished on every entry, including resume and detached re-attach, so a client that missed
  // the first announcement still learns the plan before the next task starts.
  publishTasksPlanned({ bus: wctx.bus, phase: state.phase }, state.tasks);
  // The bound is re-read every pass: a consult that inserts subtasks grows the list the
  // loop still has to run, and their indices follow the parent the split replaced.
  for (let i = state.currentTaskIndex; i < state.tasks.length; i++) {
    if (wctx.signal?.aborted) return { state, status: 'stopped' };
    const task = state.tasks[i];
    if (!task) continue;
    // A fix cycle starts at its first appended brief; a brief that passed or was skipped is not re-run.
    if (isTaskSettled(task.status)) continue;

    const depGate = await checkDependencyGate({
      wctx,
      state,
      setTrackedState,
      task,
      taskIndex: i,
    });
    state = depGate.state;
    if (depGate.stopped) return { state, status: 'stopped' };

    state = withBaseline(state, changedFilesBaseline);
    let refreshedTask = task;
    ({ task: refreshedTask, state } = await refreshAndPersistCode(
      task,
      wctx,
      state,
      wctx.workspaceDir,
      'dispatch',
    ));
    setTrackedState(state);

    const setup = await setupTaskImplementer({
      wctx,
      state,
      setTrackedState,
      task: refreshedTask,
      profiles: resolvedProfiles.profiles,
    });
    state = setup.state;
    if (setup.status === 'stopped') return { state, status: 'stopped' };

    const taskAcceptedFiles = new Set<string>();
    state = await runSingleTask({
      wctx: setup.wctx,
      task: refreshedTask,
      taskCodeRefreshed: true,
      index: i,
      totalTasks: state.tasks.length,
      state,
      taskBreakdowns,
      setTrackedState,
      setCurrentTask,
      onTaskStartSnapshot: (snapshotState, taskStartSnapshot) => {
        // On disk, not only tracked: a crash or a park between here and the brief's end
        // reads this snapshot back, and a rebase from the persisted head would lose it.
        changedFilesBaseline = withActiveTaskSnapshot(changedFilesBaseline, taskStartSnapshot);
        return commitOnHead(
          ref,
          snapshotState,
          (head) => withBaseline(head, changedFilesBaseline),
          setTrackedState,
        );
      },
      onTaskAcceptedFiles: (files) => {
        for (const file of files) taskAcceptedFiles.add(file);
      },
    });
    const finished = await finishTask({
      wctx,
      state,
      setTrackedState,
      baseline: changedFilesBaseline,
      taskIndex: i,
      refreshedTask,
      taskAcceptedFiles,
      taskBreakdowns,
    });
    state = finished.state;
    changedFilesBaseline = finished.baseline;
    if (finished.exit !== undefined) {
      setCurrentTask(undefined);
      return { state, ...finished.exit };
    }
  }
  setCurrentTask(undefined);
  return { state, status: 'complete' };
}
