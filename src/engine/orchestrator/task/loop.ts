import type { Task, TaskId } from '../../../core/schemas/task.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import { getFailedTaskIds, getSkippedTaskIds } from '../../../core/state/selectors.js';
import { nowIso } from '../../../utils/format-time.js';
import type { WorkflowContext } from '../types.js';
import { publishError, publishRecoveryPrompted, publishWarningFromError } from '../events.js';
import { runSingleTask } from './step.js';
import { refreshAndPersistCode, transitionAndSave } from '../state-ops.js';
import {
  getRunnerDisplayName,
  getRunnerModelName,
} from '../../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles } from '../../../core/config/accessors/implementer-profiles.js';
import { routeTaskToImplementerProfile } from '../context-routing/route.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { createSnapshot } from '../../snapshots/create.js';
import { recordRunSnapshot } from '../../snapshots/run.js';
import {
  buildContextOverflowRecoveryIssue,
  buildDependencyBlockedRecoveryIssue,
} from '../recovery/builders/task.js';
import {
  captureChangedFilesBaseline,
  inferTaskAcceptedChangedFiles,
  refreshChangedFilesBaseline,
} from '../changed-files-baseline.js';
import { checkUserEditConflicts } from '../user-edit/detection.js';
import {
  configForProfile,
  selectedProfileFromDecision,
  createTaskImplementer,
  retryProfileOverrideForTask,
  routingBlockMessage,
} from './routing.js';
import { reviewTaskIfNeeded } from './task-review.js';
import { checkBudgetAfterTask } from './budget-check.js';

async function maybeAutoSnapshot(opts: {
  projectDir: string;
  sessionId: string;
  config: WorkflowContext['config'];
  bus: EventBus;
  phase: Phase;
  enabled: boolean;
  taskIndex?: number;
  label: string;
  recordInRunLedger?: boolean;
}): Promise<void> {
  if (!opts.enabled) return;
  try {
    const result = await createSnapshot({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      phase: 'manual',
      name: opts.label,
      ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
      bus: opts.bus,
      eventPhase: opts.phase,
    });
    if (opts.recordInRunLedger) {
      await recordRunSnapshot(opts.projectDir, opts.sessionId, result.manifest, 'post-task');
    }
  } catch (err) {
    publishWarningFromError(
      { bus: opts.bus, phase: opts.phase },
      `auto-snapshot (${opts.label}) failed`,
      err,
    );
  }
}

function hasDependencyFailed(task: Task, failedTasks: TaskId[], skippedTasks: TaskId[]): boolean {
  const blocked = new Set<string>([...failedTasks, ...skippedTasks]);
  return task.dependsOn.some((dep) => blocked.has(dep));
}

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
  const { projectDir, sessionId, config, callbacks } = wctx;
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
    const failedTaskIds = getFailedTaskIds(state);
    const skippedTaskIds = getSkippedTaskIds(state);
    if (hasDependencyFailed(task, failedTaskIds, skippedTaskIds)) {
      const blockedByTaskIds = task.dependsOn.filter(
        (id) => failedTaskIds.includes(id) || skippedTaskIds.includes(id),
      );
      const blockedByTasks = state.tasks.filter((candidate) =>
        blockedByTaskIds.includes(candidate.id),
      );
      const issue = buildDependencyBlockedRecoveryIssue({
        task,
        blockedByTaskIds,
        blockedByTasks,
        phase: state.phase,
        createdAt: nowIso(),
      });
      state = transitionAndSave(projectDir, sessionId, state, {
        type: 'SET_PENDING_RECOVERY',
        issue,
      });
      publishRecoveryPrompted(wctx.bus, issue);
      setTrackedState(state);
      const review = await reviewTaskIfNeeded({
        wctx,
        state,
        setTrackedState,
        task,
        taskIndex: i,
        filesTouched: issue.files,
        taskBreakdowns,
      });
      state = review.state;
      return { state, taskBreakdowns, status: 'stopped' };
    }
    const conflictAction = await checkUserEditConflicts({
      projectDir,
      sessionId,
      callbacks,
      bus: wctx.bus,
      state,
      task,
      taskIndex: i,
      baseline: changedFilesBaseline,
      acknowledgedUserEditFiles,
      setTrackedState,
    });
    state = conflictAction.state;
    if (conflictAction.stopped) {
      const review = await reviewTaskIfNeeded({
        wctx,
        state,
        setTrackedState,
        task,
        taskIndex: i,
        filesTouched: state.pendingRecovery?.files ?? [],
        taskBreakdowns,
      });
      state = review.state;
      return { state, taskBreakdowns, status: 'stopped' };
    }
    let refreshedTask = task;
    ({ task: refreshedTask, state } = await refreshAndPersistCode(
      task,
      projectDir,
      sessionId,
      state,
    ));
    setTrackedState(state);
    const retryProfileOverride = retryProfileOverrideForTask(wctx, refreshedTask);
    const routingProfiles =
      retryProfileOverride === undefined
        ? resolvedProfiles.profiles
        : resolvedProfiles.profiles.filter((profile) => profile.name === retryProfileOverride);
    if (routingProfiles.length === 0) {
      const message = `Recovery selected implementer profile "${retryProfileOverride}" is not configured.`;
      publishError({ bus: wctx.bus, phase: state.phase }, message);
      const issue = buildContextOverflowRecoveryIssue({
        task: refreshedTask,
        phase: state.phase,
        selectedImplementerProfile: retryProfileOverride,
        canRouteBigger: false,
        routingReason: message,
        createdAt: nowIso(),
      });
      state = transitionAndSave(projectDir, sessionId, state, {
        type: 'SET_PENDING_RECOVERY',
        issue,
      });
      publishRecoveryPrompted(wctx.bus, issue);
      setTrackedState(state);
      return { state, taskBreakdowns, status: 'stopped' };
    }

    const routingDecision = routeTaskToImplementerProfile({
      task: refreshedTask,
      context: wctx.context,
      profiles: routingProfiles,
      languageContext: buildProjectLanguageContext(
        projectDir,
        state.discoveredValidation?.language,
      ),
    });
    const selectedProfile = selectedProfileFromDecision(resolvedProfiles.profiles, routingDecision);
    const selectedModel = selectedProfile ? getRunnerModelName(selectedProfile.config) : undefined;
    if (!selectedProfile) {
      const message = routingBlockMessage(routingDecision);
      publishError({ bus: wctx.bus, phase: state.phase }, message);
      const issue = buildContextOverflowRecoveryIssue({
        task: refreshedTask,
        phase: state.phase,
        routingDecision,
        createdAt: nowIso(),
      });
      state = transitionAndSave(projectDir, sessionId, state, {
        type: 'SET_PENDING_RECOVERY',
        issue,
      });
      publishRecoveryPrompted(wctx.bus, issue);
      setTrackedState(state);
      const review = await reviewTaskIfNeeded({
        wctx,
        state,
        setTrackedState,
        task: refreshedTask,
        taskIndex: i,
        filesTouched: issue.files,
        taskBreakdowns,
        routingDecision,
      });
      state = review.state;
      return { state, taskBreakdowns, status: 'stopped' };
    }
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
    if (
      completedTask !== undefined &&
      isTaskCompleted(completedTask.status) &&
      taskAcceptedFiles.size === 0
    ) {
      for (const file of await inferTaskAcceptedChangedFiles(projectDir, refreshedTask))
        taskAcceptedFiles.add(file);
    }
    const absorbedFiles = new Set([...taskAcceptedFiles, ...acknowledgedUserEditFiles]);
    changedFilesBaseline = await refreshChangedFilesBaseline({
      projectDir,
      baseline: changedFilesBaseline,
      absorbedFiles,
    });
    acknowledgedUserEditFiles.clear();

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

    const postTaskConflictAction = await checkUserEditConflicts({
      projectDir,
      sessionId,
      callbacks,
      bus: wctx.bus,
      state,
      task: refreshedTask,
      taskIndex: i,
      baseline: changedFilesBaseline,
      acknowledgedUserEditFiles,
      setTrackedState,
    });
    state = postTaskConflictAction.state;
    if (postTaskConflictAction.stopped) {
      const review = await reviewTaskIfNeeded({
        wctx: taskWorkflowContext,
        state,
        setTrackedState,
        task: refreshedTask,
        taskIndex: i,
        filesTouched: state.pendingRecovery?.files ?? [],
        taskBreakdowns,
        routingDecision,
        implementerProfile: selectedProfile.name,
      });
      state = review.state;
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'stopped' };
    }
    if (acknowledgedUserEditFiles.size > 0) {
      changedFilesBaseline = await refreshChangedFilesBaseline({
        projectDir,
        baseline: changedFilesBaseline,
        absorbedFiles: acknowledgedUserEditFiles,
      });
      acknowledgedUserEditFiles.clear();
    }

    const succeeded = completedTask?.status === 'done';
    await maybeAutoSnapshot({
      projectDir,
      sessionId,
      config,
      bus: wctx.bus,
      phase: state.phase,
      enabled: succeeded && config.snapshots?.auto?.postTask === true,
      taskIndex: i,
      label: `post-task-${i}`,
      recordInRunLedger: true,
    });

    const budgetCheck = await checkBudgetAfterTask({
      wctx,
      state,
      taskBreakdowns,
      totalTasks,
      budgetWarningEmitted,
      budgetPauseEmitted,
    });
    state = budgetCheck.state;
    budgetWarningEmitted = budgetCheck.warningEmitted;
    budgetPauseEmitted = budgetCheck.pauseEmitted;
    if (budgetCheck.stop) {
      setCurrentTask(undefined);
      return { state, taskBreakdowns, status: 'stopped' };
    }
  }
  setCurrentTask(undefined);
  return { state, taskBreakdowns, status: 'complete' };
}
