import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import { runSingleTask } from './step.js';
import { refreshAndPersistCode } from '../state-ops.js';
import {
  getRunnerDisplayName,
  getRunnerModelName,
} from '../../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { captureChangedFilesBaseline } from '../changed-files-baseline.js';
import { configForProfile, createTaskImplementer } from './routing.js';
import { reviewTaskIfNeeded } from './review-flow.js';
import { maybeAutoSnapshot } from './auto-snapshot.js';
import { checkDependencyGate } from './dependency-gate.js';
import { checkUserEditGate } from './user-edit-gate.js';
import { selectRoutingProfile } from './routing-selection.js';
import { absorbAcceptedFiles, reconcileAfterTask } from './post-task.js';

type RunTaskLoopOptions = {
  wctx: WorkflowContext;
  initialState: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'action'> | undefined) => void;
};

export type TaskLoopResult = {
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  status: 'complete' | 'stopped';
};

export async function runTaskLoop(opts: RunTaskLoopOptions): Promise<TaskLoopResult> {
  const { wctx, setTrackedState, setCurrentTask } = opts;
  const { projectDir, sessionId, config } = wctx;
  let state = opts.initialState;
  const totalTasks = state.tasks.length;
  const taskBreakdowns: TaskTokenUsage[] = [];
  const resolvedProfiles = resolveImplementerProfiles(config);
  const singleImplementerMode = config.implementerProfiles === undefined;
  let budgetWarningEmitted = false;
  let budgetPauseEmitted = false;
  if (state.pendingRecovery) {
    return { state, taskBreakdowns, status: 'stopped' };
  }
  let changedFilesBaseline = await captureChangedFilesBaseline(projectDir);
  const acknowledgedUserEditFiles = new Set<string>();
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
    if (depGate.stopped) return { state, taskBreakdowns, status: 'stopped' };

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
    if (preEditGate.stopped) return { state, taskBreakdowns, status: 'stopped' };

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
    if (!routing.ok) return { state, taskBreakdowns, status: 'stopped' };
    const { selectedProfile, selectedModel, routingDecision } = routing;
    const selectedTaskConfig = configForProfile(config, selectedProfile);

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
    if (reviewDecision.decision === 'stop' || wctx.signal?.aborted) {
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'stopped' };
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
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'stopped' };
    }
  }
  setCurrentTask(undefined);
  return { state, taskBreakdowns, status: 'complete' };
}
