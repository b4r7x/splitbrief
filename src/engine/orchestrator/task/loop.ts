import { isTaskCompleted, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import { runSingleTask } from './step.js';
import { commitWorkflowState, raisePendingRecovery } from '../state-ops.js';
import { refreshAndPersistCode } from './refresh-code.js';
import {
  getRunnerDisplayName,
  getRunnerModelName,
} from '../../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import {
  captureChangedFilesBaseline,
  deserializeChangedFilesBaseline,
  serializeChangedFilesBaseline,
  unreadableChangedFiles,
  withActiveTaskSnapshot,
  type ChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { configForProfile, createTaskImplementer } from './routing.js';
import { publishError, publishTasksPlanned, publishWarning } from '../events.js';
import { checkDependencyGate } from './dependency-gate.js';
import { selectRoutingProfile } from './routing-selection.js';
import { absorbAcceptedFiles } from './post-task.js';
import { nowIso } from '../../../utils/format-time.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';
import { buildImplementerUnavailableRecoveryIssue } from '../recovery/builders/task.js';
import { runScheduledReview } from '../run/review.js';
import { recordCheckoutRunSnapshot } from '../run/snapshots.js';

type RunTaskLoopOptions = {
  wctx: WorkflowContext;
  initialState: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'suggestedFiles' | 'action'> | undefined) => void;
};

export type TaskLoopResult = {
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  status: 'complete' | 'stopped' | 'paused';
};

export async function runTaskLoop(opts: RunTaskLoopOptions): Promise<TaskLoopResult> {
  const { wctx, setTrackedState, setCurrentTask } = opts;
  const { projectDir, sessionId, config } = wctx;
  let state = opts.initialState;
  // Seed from persisted breakdowns so re-entry (resume / rewind / detached retry)
  // keeps per-task cost identity for already-completed tasks (F-454).
  const taskBreakdowns: TaskTokenUsage[] = [...(state.taskBreakdowns ?? [])];

  function syncBaselineIntoState(nextState: WorkflowState = state): WorkflowState {
    state = {
      ...nextState,
      changedFilesBaseline: serializeChangedFilesBaseline(changedFilesBaseline),
    };
    return state;
  }

  function commitTrackedState(next: WorkflowState): WorkflowState {
    const committed = commitWorkflowState({
      ref: { projectDir, sessionId },
      expected: next,
      next,
    });
    if (committed.kind === 'conflict') {
      throw error(
        'state-persistence-conflict',
        'Workflow state changed before task metadata could be persisted.',
      );
    }
    if (committed.kind === 'durability-uncertain') {
      throw error(
        'state-persistence-durability-uncertain',
        'Workflow task metadata persistence is uncertain.',
      );
    }
    state = committed.state;
    setTrackedState(state);
    return state;
  }

  function persistTaskBreakdowns(): void {
    state = { ...state, taskBreakdowns: [...taskBreakdowns] };
    commitTrackedState(syncBaselineIntoState());
  }

  const resolvedProfiles = resolveImplementerProfiles(config);
  const singleImplementerMode = config.implementerProfiles === undefined;
  if (state.pendingRecovery) {
    const recovery = state.pendingRecovery;
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message: `Recovery is still pending (reason: ${recovery.reason}, status: ${recovery.status}); no task work was started. Available actions: ${recovery.availableActions.join(', ')}.`,
      safety: { category: 'recovery', code: 'recovery_pending_unresolved' },
    });
    return { state, taskBreakdowns, status: 'stopped' };
  }
  if (state.pendingScheduledReview !== undefined) {
    const pending = await runScheduledReview({
      wctx,
      state,
      setTrackedState,
      callbacks: wctx.callbacks,
    });
    state = pending.state;
    if (pending.status === 'stopped') return { state, taskBreakdowns, status: 'stopped' };
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
    if (wctx.signal?.aborted) return { state, taskBreakdowns, status: 'stopped' };
    const task = state.tasks[i];
    if (!task) continue;
    // A fix cycle starts at its first appended brief; briefs that already passed are not re-run.
    if (isTaskCompleted(task.status)) continue;

    const depGate = await checkDependencyGate({
      wctx,
      state,
      setTrackedState,
      task,
      taskIndex: i,
    });
    state = depGate.state;
    if (depGate.stopped) return { state, taskBreakdowns, status: 'stopped' };

    syncBaselineIntoState();
    let refreshedTask = task;
    ({ task: refreshedTask, state } = await refreshAndPersistCode(
      task,
      wctx,
      state,
      wctx.workspaceDir,
      'dispatch',
    ));
    setTrackedState(state);

    const routing = await selectRoutingProfile({
      wctx,
      state,
      setTrackedState,
      task: refreshedTask,
      resolvedProfiles: resolvedProfiles.profiles,
      getRunnerModelName,
    });
    state = routing.state;
    if (!routing.ok) return { state, taskBreakdowns, status: 'stopped' };
    const { selectedProfile, selectedModel, routingDecision } = routing;
    const selectedTaskConfig = configForProfile(
      config,
      selectedProfile,
      routingDecision.contextLength,
    );

    const taskImplementer = await createTaskImplementer({
      wctx,
      profile: selectedProfile,
      singleImplementerMode,
    });
    let isImplementerAvailable = false;
    let availabilityError: string | undefined;
    try {
      isImplementerAvailable = await taskImplementer.isAvailable();
    } catch (err) {
      availabilityError = toErrorMessage(err);
    }
    if (!isImplementerAvailable) {
      const tool = getRunnerDisplayName(selectedProfile.config);
      const reason =
        availabilityError ??
        taskImplementer.unavailabilityReason?.() ??
        `Selected implementer profile ${selectedProfile.name} (${tool}) is unavailable. Check runner installation, API credentials, or endpoint reachability.`;
      publishError({ bus: wctx.bus, phase: state.phase, message: reason });
      state = raisePendingRecovery(
        wctx,
        state,
        buildImplementerUnavailableRecoveryIssue({
          task: refreshedTask,
          phase: state.phase,
          selectedImplementerProfile: selectedProfile.name,
          tool,
          ...(selectedModel !== undefined && { model: selectedModel }),
          availabilityReason: reason,
          createdAt: nowIso(),
        }),
        setTrackedState,
      );
      return { state, taskBreakdowns, status: 'stopped' };
    }
    const { implementerModel: _previousImplementerModel, ...stateWithoutImplementerModel } = state;
    const taskState: WorkflowState = {
      ...stateWithoutImplementerModel,
      implementerTool: getRunnerDisplayName(selectedProfile.config),
      ...(selectedModel !== undefined && { implementerModel: selectedModel }),
    };
    const taskWorkflowContext: WorkflowContext = {
      ...wctx,
      config: selectedTaskConfig,
      implementer: taskImplementer,
      implementerProfile: selectedProfile.name,
      routingDecision,
    };

    const taskAcceptedFiles = new Set<string>();
    state = await runSingleTask({
      wctx: taskWorkflowContext,
      task: refreshedTask,
      taskCodeRefreshed: true,
      index: i,
      totalTasks: state.tasks.length,
      state: taskState,
      taskBreakdowns,
      setTrackedState,
      setCurrentTask,
      onTaskStartSnapshot: (snapshotState, taskStartSnapshot) => {
        // On disk, not only tracked: a crash or a park between here and the brief's end
        // reads this snapshot back, and a rebase from the persisted head would lose it.
        changedFilesBaseline = withActiveTaskSnapshot(changedFilesBaseline, taskStartSnapshot);
        return commitTrackedState(syncBaselineIntoState(snapshotState));
      },
      onTaskAcceptedFiles: (files) => {
        for (const file of files) taskAcceptedFiles.add(file);
      },
    });
    const activeTaskSnapshot = state.changedFilesBaseline?.activeTaskSnapshot;
    if (activeTaskSnapshot !== undefined) {
      changedFilesBaseline = withActiveTaskSnapshot(changedFilesBaseline, activeTaskSnapshot);
    }
    const completedTask = state.tasks[i];
    changedFilesBaseline = await absorbAcceptedFiles({
      projectDir,
      sessionId,
      baseline: changedFilesBaseline,
      completedTask,
      refreshedTask,
      taskAcceptedFiles,
    });
    // A stop at this boundary parks from the persisted head, which would otherwise lack this
    // brief's files and usage.
    persistTaskBreakdowns();
    await recordCheckoutRunSnapshot({ projectDir, sessionId, bus: wctx.bus, state });

    if (wctx.signal?.aborted || state.currentTaskIndex <= i) {
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'stopped' };
    }

    // The configured cadence: with workflow.review 'task' every brief that passed its
    // validation is reviewed before the loop moves on; a failing review's fix tasks are
    // appended and the re-read bound runs them.
    if ((config.workflow.review ?? 'end') === 'task') {
      const scheduled = await runScheduledReview({
        wctx,
        state,
        setTrackedState,
        callbacks: wctx.callbacks,
        ...(completedTask !== undefined && { afterTaskId: completedTask.id }),
      });
      state = scheduled.state;
      if (scheduled.status === 'stopped') {
        setCurrentTask(undefined);
        return { state, taskBreakdowns, status: 'stopped' };
      }
    }

    if (wctx.sinks.consumeBoundaryPause?.()) {
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'paused' };
    }
  }
  setCurrentTask(undefined);
  return { state, taskBreakdowns, status: 'complete' };
}
