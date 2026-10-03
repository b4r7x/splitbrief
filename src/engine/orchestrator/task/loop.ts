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
  refreshChangedFilesBaseline,
  serializeChangedFilesBaseline,
  unreadableChangedFiles,
  withActiveTaskSnapshot,
  type ChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { configForProfile, createTaskImplementer } from './routing.js';
import { publishError, publishTasksPlanned, publishWarning } from '../events.js';
import { checkDependencyGate } from './dependency-gate.js';
import { checkUserEditConflicts } from '../user-edit/detection.js';
import { selectRoutingProfile } from './routing-selection.js';
import { absorbAcceptedFiles, reconcileAfterTask } from './post-task.js';
import { nowIso } from '../../../utils/format-time.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';
import { buildImplementerUnavailableRecoveryIssue } from '../recovery/builders/task.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';

type RunTaskLoopOptions = {
  wctx: WorkflowContext;
  initialState: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'files' | 'action'> | undefined) => void;
};

export type TaskLoopResult = {
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  status: 'complete' | 'stopped' | 'cancelled' | 'paused';
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
      safety: { category: 'user-edit', code: 'unreadable_changed_files' },
    });
  }
  const acknowledgedUserEditFiles = new Set<string>();
  // Republished on every entry, including resume and detached re-attach, so a client that missed
  // the first announcement still learns the plan before the next task starts.
  publishTasksPlanned({ bus: wctx.bus, phase: state.phase }, state.tasks);
  const firstTask = state.tasks[state.currentTaskIndex];
  if (firstTask) {
    const primedBaseline = await wctx.validator.primeBaseline({
      bus: wctx.bus,
      phase: state.phase,
      task: firstTask,
      projectDir,
      config,
      discoveredValidation: state.discoveredValidation,
      persistedBaseline: state.validationBaseline,
      signal: wctx.signal,
    });
    if (primedBaseline !== undefined && state.validationBaseline === undefined) {
      state = { ...state, validationBaseline: primedBaseline };
      setTrackedState(state);
    }
  }
  for (let i = state.currentTaskIndex; i < totalTasks; i++) {
    if (wctx.signal?.aborted) return { state, taskBreakdowns, status: 'stopped' };
    const task = state.tasks[i];
    if (!task) continue;
    // A review-fix re-entry starts at the first brief it reopened; the briefs
    // after it that already passed are not re-run.
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
    const preEditGate = await checkUserEditConflicts({
      projectDir,
      sessionId,
      callbacks: wctx.callbacks,
      bus: wctx.bus,
      state,
      setTrackedState,
      task,
      taskIndex: i,
      baseline: changedFilesBaseline,
      acknowledgedUserEditFiles,
    });
    state = preEditGate.state;
    if (preEditGate.stopped) {
      return { state, taskBreakdowns, status: preEditGate.cancelled ? 'cancelled' : 'stopped' };
    }
    // An acknowledged edit is the new floor: folding it in here is what keeps the next entry
    // from asking about the same bytes again. No task snapshot exists yet, so none is lost.
    if (preEditGate.absorbedFiles.length > 0) {
      changedFilesBaseline = await refreshChangedFilesBaseline({
        projectDir,
        baseline: changedFilesBaseline,
        absorbedFiles: new Set(preEditGate.absorbedFiles),
      });
      state = commitTrackedState(syncBaselineIntoState());
    }

    let refreshedTask = task;
    ({ task: refreshedTask, state } = await refreshAndPersistCode(task, wctx, state));
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
        // On disk, not only tracked: a crash or a park between here and the brief's end
        // reads this snapshot back, and a rebase from the persisted head would lose it.
        changedFilesBaseline = withActiveTaskSnapshot(changedFilesBaseline, taskStartSnapshot);
        return commitTrackedState(syncBaselineIntoState(snapshotState));
      },
      onTaskAcceptedFiles: (files) => {
        for (const file of files) taskAcceptedFiles.add(file);
      },
    });
    const completedTask = state.tasks[i];
    changedFilesBaseline = await absorbAcceptedFiles({
      projectDir,
      sessionId,
      baseline: changedFilesBaseline,
      completedTask,
      refreshedTask,
      taskAcceptedFiles,
      acknowledgedUserEditFiles,
    });
    // On disk, not only tracked: a stop at this boundary parks from the persisted head, which
    // would otherwise lack this brief's files (read back as a user edit) and its usage.
    persistTaskBreakdowns();

    if (wctx.signal?.aborted || state.currentTaskIndex <= i) {
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'stopped' };
    }

    const reconcile = await reconcileAfterTask({
      wctx,
      state,
      setTrackedState,
      task: refreshedTask,
      taskIndex: i,
      baseline: changedFilesBaseline,
      acknowledgedUserEditFiles,
    });
    state = reconcile.state;
    changedFilesBaseline = reconcile.baseline;
    if (reconcile.stop) {
      if (deriveRunStatus({ state, liveness: 'not-alive' }).kind !== 'closed') {
        persistTaskBreakdowns();
      }
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: reconcile.cancelled ? 'cancelled' : 'stopped' };
    }

    persistTaskBreakdowns();

    if (wctx.sinks.consumeBoundaryPause?.()) {
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'paused' };
    }
  }
  setCurrentTask(undefined);
  return { state, taskBreakdowns, status: 'complete' };
}
