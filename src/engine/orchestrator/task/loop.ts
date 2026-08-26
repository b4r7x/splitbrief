import type { Task } from '../../../core/schemas/task.js';
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
import { reviewTaskIfNeeded } from './review-flow.js';
import { maybeAutoSnapshot } from './auto-snapshot.js';
import { checkDependencyGate } from './dependency-gate.js';
import { checkUserEditGate } from './user-edit-gate.js';
import { selectRoutingProfile } from './routing-selection.js';
import { absorbAcceptedFiles, reconcileAfterTask } from './post-task.js';
import { nowIso } from '../../../utils/format-time.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';
import { buildImplementerUnavailableRecoveryIssue } from '../recovery/builders/task.js';

type RunTaskLoopOptions = {
  wctx: WorkflowContext;
  initialState: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'action'> | undefined) => void;
};

export type TaskLoopResult = {
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  status: 'complete' | 'stopped' | 'cancelled';
};

export async function runTaskLoop(opts: RunTaskLoopOptions): Promise<TaskLoopResult> {
  const { wctx, setTrackedState, setCurrentTask } = opts;
  const { projectDir, sessionId, config } = wctx;
  let state = opts.initialState;
  const totalTasks = state.tasks.length;
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

  function persistBaselineState(nextState: WorkflowState = state): WorkflowState {
    const synced = syncBaselineIntoState(nextState);
    setTrackedState(synced);
    return synced;
  }

  function persistTaskBreakdowns(): void {
    state = { ...state, taskBreakdowns: [...taskBreakdowns] };
    const nextState = syncBaselineIntoState();
    const committed = commitWorkflowState({
      ref: { projectDir, sessionId },
      expected: nextState,
      next: nextState,
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
  }

  const resolvedProfiles = resolveImplementerProfiles(config);
  const singleImplementerMode = config.implementerProfiles === undefined;
  let budgetWarningEmitted = false;
  let budgetPauseEmitted = false;
  if (state.pendingRecovery) {
    const recovery = state.pendingRecovery;
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message: `Recovery is still pending (reason: ${recovery.reason}, status: ${recovery.status}); no task work was started. Available actions: ${recovery.availableActions.join(', ')}.`,
      safety: { category: 'recovery', code: 'recovery_pending_unresolved', transcriptSafe: true },
    });
    return { state, taskBreakdowns, status: 'stopped' };
  }
  let changedFilesBaseline: ChangedFilesBaseline =
    state.changedFilesBaseline !== undefined
      ? deserializeChangedFilesBaseline(state.changedFilesBaseline)
      : await captureChangedFilesBaseline(projectDir);
  const unreadableFiles = unreadableChangedFiles(changedFilesBaseline);
  if (unreadableFiles.length > 0) {
    publishWarning({
      bus: wctx.bus,
      phase: state.phase,
      message: `Ignoring changed files that could not be read: ${unreadableFiles.join(', ')}.`,
      safety: { category: 'user-edit', code: 'unreadable_changed_files', transcriptSafe: true },
    });
  }
  const acknowledgedUserEditFiles = new Set<string>();
  // Republished on every entry, including resume and detached re-attach, so a client that missed
  // the first announcement still learns the plan before the next task starts.
  publishTasksPlanned({ bus: wctx.bus, phase: state.phase }, state.tasks);
  const firstTask = state.tasks[state.currentTaskIndex];
  if (firstTask) {
    await wctx.validator.primeBaseline({
      bus: wctx.bus,
      phase: state.phase,
      task: firstTask,
      projectDir,
      config,
      discoveredValidation: state.discoveredValidation,
      signal: wctx.signal,
    });
  }
  for (let i = state.currentTaskIndex; i < totalTasks; i++) {
    if (wctx.signal?.aborted) return { state, taskBreakdowns, status: 'stopped' };
    const task = state.tasks[i];
    if (!task) continue;

    const depGate = await checkDependencyGate({
      wctx,
      state,
      setTrackedState,
      task,
      taskIndex: i,
      taskBreakdowns,
    });
    state = depGate.state;
    if (depGate.stopped) {
      return { state, taskBreakdowns, status: depGate.cancelled ? 'cancelled' : 'stopped' };
    }

    syncBaselineIntoState();
    const preEditGate = await checkUserEditGate({
      wctx,
      reviewWctx: wctx,
      state,
      setTrackedState,
      task,
      taskIndex: i,
      baseline: changedFilesBaseline,
      acknowledgedUserEditFiles,
      taskBreakdowns,
    });
    state = preEditGate.state;
    if (preEditGate.stopped) {
      return { state, taskBreakdowns, status: preEditGate.cancelled ? 'cancelled' : 'stopped' };
    }

    let refreshedTask = task;
    ({ task: refreshedTask, state } = await refreshAndPersistCode(task, wctx, state));
    setTrackedState(state);

    const routing = await selectRoutingProfile({
      wctx,
      state,
      setTrackedState,
      task: refreshedTask,
      taskIndex: i,
      resolvedProfiles: resolvedProfiles.profiles,
      taskBreakdowns,
      getRunnerModelName,
    });
    state = routing.state;
    if (!routing.ok) {
      return { state, taskBreakdowns, status: routing.cancelled ? 'cancelled' : 'stopped' };
    }
    const { selectedProfile, selectedModel, routingDecision } = routing;
    const selectedTaskConfig = configForProfile(
      config,
      selectedProfile,
      routingDecision.contextLength,
    );

    await maybeAutoSnapshot({
      projectDir,
      sessionId,
      config,
      bus: wctx.bus,
      phase: state.phase,
      enabled: config.snapshots?.auto?.preTask === true,
      taskIndex: i,
      label: `pre-task-${i}`,
    });

    const taskImplementer = await createTaskImplementer({
      wctx,
      profile: selectedProfile,
      taskConfig: selectedTaskConfig,
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
      totalTasks,
      state: taskState,
      taskBreakdowns,
      setTrackedState,
      setCurrentTask,
      onTaskStartSnapshot: (snapshotState, taskStartSnapshot) => {
        changedFilesBaseline = withActiveTaskSnapshot(changedFilesBaseline, taskStartSnapshot);
        return persistBaselineState(snapshotState);
      },
      onTaskAcceptedFiles: (files) => {
        for (const file of files) taskAcceptedFiles.add(file);
      },
    });
    const completedTask = state.tasks[i];
    changedFilesBaseline = await absorbAcceptedFiles({
      projectDir,
      baseline: changedFilesBaseline,
      completedTask,
      refreshedTask,
      taskAcceptedFiles,
      acknowledgedUserEditFiles,
    });
    persistBaselineState();

    const reviewDecision = await reviewTaskIfNeeded({
      wctx: taskWorkflowContext,
      state,
      setTrackedState,
      task: completedTask ?? refreshedTask,
      taskIndex: i,
      filesTouched: [...taskAcceptedFiles],
      taskBreakdowns,
      routingDecision,
      implementerProfile: selectedProfile.name,
    });
    state = reviewDecision.state;
    if (reviewDecision.decision === 'abort') {
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'cancelled' };
    }
    if (reviewDecision.decision === 'stop' || wctx.signal?.aborted) {
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'stopped' };
    }
    if (reviewDecision.decision === 'redo-task') {
      wctx.bus.publish({
        type: 'task_reset',
        ts: Date.now(),
        phase: state.phase,
        taskId: refreshedTask.id,
      });
      i--;
      continue;
    }

    if (state.currentTaskIndex <= i) {
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'stopped' };
    }

    const reconcile = await reconcileAfterTask({
      wctx,
      taskWctx: taskWorkflowContext,
      state,
      setTrackedState,
      task: refreshedTask,
      taskIndex: i,
      totalTasks,
      baseline: changedFilesBaseline,
      acknowledgedUserEditFiles,
      taskBreakdowns,
      routingDecision,
      implementerProfile: selectedProfile.name,
      completedTask,
      budgetWarningEmitted,
      budgetPauseEmitted,
      autoSnapshot: maybeAutoSnapshot,
    });
    state = reconcile.state;
    changedFilesBaseline = reconcile.baseline;
    budgetWarningEmitted = reconcile.budgetWarningEmitted;
    budgetPauseEmitted = reconcile.budgetPauseEmitted;
    if (reconcile.stop) {
      persistTaskBreakdowns();
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'stopped' };
    }

    persistTaskBreakdowns();
  }
  setCurrentTask(undefined);
  return { state, taskBreakdowns, status: 'complete' };
}
