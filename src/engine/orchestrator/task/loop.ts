import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import { labelError } from '../../../utils/format-errors.js';
import { getFailedTaskIds, getSkippedTaskIds, getEscalatedTaskIds } from '../../../core/state/selectors.js';

import type { WorkflowContext } from '../types.js';
import { createImplementerPublisher, publishError, publishRecoveryPrompted, publishTaskReviewNeeded, publishWarning } from '../events.js';
import { runSingleTask } from './step.js';
import { refreshAndPersistCode, transitionAndSave } from '../state-ops.js';
import { enforceBudget } from '../budget/budget.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles, type ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { routeTaskToImplementerProfile, type RoutingDecision } from '../context-routing.js';
import { createImplementer } from '../../runners/factory.js';
import { createSnapshot } from '../../snapshots/store.js';
import { recordRunSnapshot } from '../../snapshots/run.js';
import type { Implementer } from '../../implementers/types.js';
import {
  buildBudgetExceededRecoveryIssue,
  buildBudgetPausedRecoveryIssue,
  buildContextOverflowRecoveryIssue,
  buildDependencyBlockedRecoveryIssue,
} from '../recovery/recovery.js';
import { buildTaskReviewRequest, shouldReviewTask, type TaskReviewRequest } from './review.js';
import { enqueueUserMessage } from '../queue.js';
import { captureChangedFilesBaseline, inferTaskAcceptedChangedFiles, refreshChangedFilesBaseline } from '../changed-files-baseline.js';
import { checkUserEditConflicts } from '../user-edit/detection.js';

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
    publishWarning(opts.bus, opts.phase, labelError(`auto-snapshot (${opts.label}) failed`, err));
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

function taskConfigForProfile(config: WorkflowContext['config'], profile: ResolvedImplementerProfile): WorkflowContext['config'] {
  return { ...config, implementer: profile.config };
}

function selectedProfileFromDecision(
  profiles: ResolvedImplementerProfile[],
  decision: RoutingDecision,
): ResolvedImplementerProfile | undefined {
  if (decision.selectedProfile === undefined) return undefined;
  return profiles.find(profile => profile.name === decision.selectedProfile);
}

function createTaskImplementer(opts: {
  wctx: WorkflowContext;
  profile: ResolvedImplementerProfile;
  taskConfig: WorkflowContext['config'];
  singleImplementerMode: boolean;
}): Implementer {
  if (opts.singleImplementerMode && opts.profile.isDefault) return opts.wctx.implementer;
  const factory = opts.wctx.createImplementer ?? createImplementer;
  return factory(opts.taskConfig, { publisher: createImplementerPublisher(opts.wctx.bus) });
}

async function reviewTaskIfNeeded(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  task: Task;
  taskIndex: number;
  filesTouched: string[];
  taskBreakdowns: TaskTokenUsage[];
  routingDecision?: RoutingDecision | undefined;
  implementerProfile?: string | undefined;
}): Promise<{ state: WorkflowState; decision: 'continue' | 'stop' }> {
  if ((opts.wctx.config.workflow.taskReview ?? 'none') === 'none') {
    return { state: opts.state, decision: 'continue' };
  }
  const request = buildTaskReviewRequest({
    projectDir: opts.wctx.projectDir,
    sessionId: opts.wctx.sessionId,
    task: opts.task,
    state: opts.state,
    filesTouched: opts.filesTouched,
    taskBreakdowns: opts.taskBreakdowns,
    routingDecision: opts.routingDecision,
    implementerProfile: opts.implementerProfile,
  });
  if (!shouldReviewTask({
    mode: opts.wctx.config.workflow.taskReview,
    request,
    taskIndex: opts.taskIndex,
    currentTaskIndex: opts.state.currentTaskIndex,
  })) {
    return { state: opts.state, decision: 'continue' };
  }
  publishTaskReviewNeeded(opts.wctx.bus, opts.state.phase, request);
  const response = opts.wctx.callbacks.onTaskReviewNeeded
    ? await opts.wctx.callbacks.onTaskReviewNeeded(request)
    : { action: 'abort' as const };
  if (response.action !== 'continue') return { state: opts.state, decision: 'stop' };

  const notes = response.notes?.trim();
  if (!notes) return { state: opts.state, decision: 'continue' };

  const queued = enqueueUserMessage(
    opts.wctx.projectDir,
    opts.wctx.sessionId,
    opts.state,
    formatTaskReviewNotes(request, notes),
    opts.state.phase,
    opts.wctx.bus,
    opts.wctx.config.workflow.persistTranscript,
  );
  opts.setTrackedState(queued.state);
  return { state: queued.state, decision: 'continue' };
}

function formatTaskReviewNotes(request: TaskReviewRequest, notes: string): string {
  return `Task review note for ${request.taskId} - ${request.taskTitle}:\n${notes}`;
}

function routingBlockMessage(decision: RoutingDecision): string {
  const context = decision.contextLength === undefined
    ? `${decision.estimatedTokens} estimated tokens`
    : `${decision.estimatedTokens}/${decision.contextLength} estimated tokens`;
  return [
    `Task ${decision.taskId} cannot be routed to an implementer profile (${context}).`,
    'Ask the planner to split the task, reduce required context, or escalate to a larger implementer profile.',
    decision.reason,
  ].join(' ');
}

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

  // Budget pause fires only at task boundaries. A long-running planner call
  // will not be interrupted mid-stream; the pause applies to the next task start.
  for (let i = state.currentTaskIndex; i < totalTasks; i++) {
    if (wctx.signal?.aborted) return { state, taskBreakdowns, status: 'stopped' };

    const task = state.tasks[i];
    if (!task) continue;

    const failedTaskIds = getFailedTaskIds(state);
    const skippedTaskIds = getSkippedTaskIds(state);
    if (hasDependencyFailed(task, failedTaskIds, skippedTaskIds)) {
      const blockedByTaskIds = task.dependsOn.filter((id) =>
        failedTaskIds.includes(id) || skippedTaskIds.includes(id)
      );
      const blockedByTasks = state.tasks.filter((candidate) => blockedByTaskIds.includes(candidate.id));
      const issue = buildDependencyBlockedRecoveryIssue({
        task,
        blockedByTaskIds,
        blockedByTasks,
        phase: state.phase,
        createdAt: new Date().toISOString(),
      });
      state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PENDING_RECOVERY', issue });
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
    ({ task: refreshedTask, state } = await refreshAndPersistCode(task, projectDir, sessionId, state));
    setTrackedState(state);

    const routingDecision = routeTaskToImplementerProfile({
      task: refreshedTask,
      context: wctx.context,
      profiles: resolvedProfiles.profiles,
    });
    const selectedProfile = selectedProfileFromDecision(resolvedProfiles.profiles, routingDecision);
    const selectedModel = selectedProfile ? getRunnerModelName(selectedProfile.config) : undefined;
    if (!selectedProfile) {
      const message = routingBlockMessage(routingDecision);
      publishError(wctx.bus, state.phase, message);
      const issue = buildContextOverflowRecoveryIssue({
        task: refreshedTask,
        phase: state.phase,
        routingDecision,
        createdAt: new Date().toISOString(),
      });
      state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PENDING_RECOVERY', issue });
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
    const selectedTaskConfig = taskConfigForProfile(config, selectedProfile);

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

    const taskImplementer = createTaskImplementer({
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
    if ((completedTask?.status === 'done' || completedTask?.status === 'escalated') && taskAcceptedFiles.size === 0) {
      for (const file of await inferTaskAcceptedChangedFiles(projectDir, refreshedTask)) {
        taskAcceptedFiles.add(file);
      }
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

    if (config.workflow.maxBudget !== undefined) {
      const plannerModel = state.plannerModel ?? getRunnerModelName(config.planner);
      const implementerTool = state.implementerTool ?? getRunnerDisplayName(config.implementer);
      const implementerModel = state.implementerModel ?? getRunnerModelName(config.implementer);
      const budgetResult = await enforceBudget({
        tokenUsage: state.tokenUsage,
        maxBudget: config.workflow.maxBudget,
        totalTasks,
        escalatedCount: getEscalatedTaskIds(state).length,
        plannerTool: state.plannerTool ?? getRunnerDisplayName(config.planner),
        implementerTool,
        ...(plannerModel !== undefined && { plannerModel }),
        ...(implementerModel !== undefined && { implementerModel }),
        taskBreakdowns,
        pricingCache: wctx.modelCache,
        callbacks,
        bus: wctx.bus,
        warningEmitted: budgetWarningEmitted,
        pauseEmitted: budgetPauseEmitted,
        pauseThreshold: config.workflow.budgetPauseThreshold,
      });
      budgetWarningEmitted = budgetResult.warningEmitted;
      budgetPauseEmitted = budgetResult.pauseEmitted;
      if (budgetResult.stop) {
        setCurrentTask(undefined);
        if (budgetResult.recovery) {
          const nextTask = state.tasks[state.currentTaskIndex];
          const blockedStep = nextTask ? `before ${nextTask.id}` : 'before final review';
          const issue = budgetResult.recovery.reason === 'budget-paused'
            ? buildBudgetPausedRecoveryIssue({
                currentCost: budgetResult.recovery.currentCost,
                maxBudget: budgetResult.recovery.maxBudget,
                phase: state.phase,
                threshold: budgetResult.recovery.threshold,
                blockedStep,
                nextTask,
                createdAt: new Date().toISOString(),
              })
            : buildBudgetExceededRecoveryIssue({
                currentCost: budgetResult.recovery.currentCost,
                maxBudget: budgetResult.recovery.maxBudget,
                phase: state.phase,
                blockedStep,
                nextTask,
                createdAt: new Date().toISOString(),
              });
          state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PENDING_RECOVERY', issue });
          publishRecoveryPrompted(wctx.bus, issue);
          setTrackedState(state);
        }
        return { state, taskBreakdowns, status: 'stopped' };
      }
    }
  }
  setCurrentTask(undefined);

  return { state, taskBreakdowns, status: 'complete' };
}
