import type { Task, TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks } from './types.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { EventBus } from '../events/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCurrentChangedFiles } from '../../lib/git.js';
import { labelError } from '../../utils/format-errors.js';
import { getFailedTaskIds, getSkippedTaskIds, getEscalatedTaskIds } from '../../core/state/selectors.js';

import type { WorkflowContext } from './types.js';
import { publishError, publishRecoveryPrompted, publishUserEditConflict, publishWarning } from './events.js';
import { runSingleTask } from './task-step.js';
import { refreshAndPersistCode, transitionAndSave } from './state-ops.js';
import { enforceBudget } from './budget.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles, type ResolvedImplementerProfile } from '../../core/config/accessors/implementer-profiles.js';
import { routeTaskToImplementerProfile, type RoutingDecision } from './context-routing.js';
import { createImplementer } from '../runners/factory.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { createSnapshot } from '../snapshots/store.js';
import { recordRunSnapshot } from '../snapshots/run.js';
import {
  classifyUserEditConflict,
  normalizeUserEditConflictAction,
} from './user-edit-conflicts.js';
import type { Implementer } from '../implementers/types.js';
import { matchesActionPattern } from './action-classifier.js';
import {
  buildBudgetExceededRecoveryIssue,
  buildBudgetPausedRecoveryIssue,
  buildContextOverflowRecoveryIssue,
  buildDependencyBlockedRecoveryIssue,
  buildUserEditConflictRecoveryIssue,
} from './recovery.js';

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

type ChangedFilesBaseline = Map<string, string>;

function isInternalDiptychArtifact(file: string): boolean {
  return file.startsWith('.diptych/');
}

function userVisibleChangedFiles(files: string[]): string[] {
  return files.filter((file) => !isInternalDiptychArtifact(file));
}

async function fingerprintChangedFile(projectDir: string, file: string): Promise<string> {
  try {
    const content = await readFile(join(projectDir, file));
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return 'missing';
  }
}

async function captureChangedFilesBaseline(projectDir: string, files?: string[]): Promise<ChangedFilesBaseline> {
  const changedFiles = userVisibleChangedFiles(files ?? await getCurrentChangedFiles(projectDir));
  const entries = await Promise.all(changedFiles.map(async (file) => [file, await fingerprintChangedFile(projectDir, file)] as const));
  return new Map(entries);
}

async function changedFilesSinceBaseline(projectDir: string, baseline: ChangedFilesBaseline): Promise<string[]> {
  const currentFiles = userVisibleChangedFiles(await getCurrentChangedFiles(projectDir));
  const current = await captureChangedFilesBaseline(projectDir, currentFiles);
  return currentFiles.filter((file) => baseline.get(file) !== current.get(file));
}

async function refreshChangedFilesBaseline(opts: {
  projectDir: string;
  baseline: ChangedFilesBaseline;
  absorbedFiles: Set<string>;
}): Promise<ChangedFilesBaseline> {
  const currentFiles = userVisibleChangedFiles(await getCurrentChangedFiles(opts.projectDir));
  const current = await captureChangedFilesBaseline(opts.projectDir, currentFiles);
  const next = new Map<string, string>();

  for (const file of currentFiles) {
    if (opts.absorbedFiles.has(file)) {
      const fingerprint = current.get(file);
      if (fingerprint !== undefined) next.set(file, fingerprint);
    } else {
      const previous = opts.baseline.get(file);
      if (previous !== undefined) next.set(file, previous);
    }
  }

  return next;
}

async function inferTaskAcceptedChangedFiles(projectDir: string, task: Task): Promise<string[]> {
  const patterns = [
    task.file,
    ...(task.scope?.inBounds ?? []),
    ...(task.scope?.approvedOutOfBounds ?? []),
  ];
  const changedFiles = userVisibleChangedFiles(await getCurrentChangedFiles(projectDir));
  return changedFiles.filter((file) => patterns.some((pattern) => matchesActionPattern(file, pattern)));
}

async function checkUserEditConflicts(opts: {
  projectDir: string;
  sessionId: string;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  state: WorkflowState;
  task: Task;
  taskIndex: number;
  baseline: ChangedFilesBaseline;
  acknowledgedUserEditFiles: Set<string>;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ state: WorkflowState; stopped: boolean }> {
  const { projectDir, sessionId, callbacks, bus, task, taskIndex, baseline, acknowledgedUserEditFiles, setTrackedState } = opts;
  let { state } = opts;
  try {
    const changedFiles = await changedFilesSinceBaseline(projectDir, baseline);
    if (changedFiles.length === 0) return { state, stopped: false };

    const conflict = classifyUserEditConflict({
      files: changedFiles,
      currentTask: task,
      allTasks: state.tasks,
      currentTaskIndex: taskIndex,
    });

    if (conflict.kind === 'unrelated') {
      for (const fileConflict of conflict.fileConflicts) {
        acknowledgedUserEditFiles.add(fileConflict.file);
      }
      publishUserEditConflict(bus, state.phase, conflict, 'continue-unrelated');
      return { state, stopped: false };
    }

    const selectedAction = conflict.safeToContinue
      ? normalizeUserEditConflictAction(
          conflict,
          callbacks.onUserEditConflict
            ? await callbacks.onUserEditConflict(conflict)
            : 'continue-unrelated',
          'continue-unrelated',
        )
      : 'pause';
    publishUserEditConflict(bus, state.phase, conflict, selectedAction);

    if (selectedAction === 'continue-unrelated' && conflict.safeToContinue) {
      for (const fileConflict of conflict.fileConflicts) {
        if (fileConflict.kind === 'unrelated' || fileConflict.kind === 'future-task-stale-input') {
          acknowledgedUserEditFiles.add(fileConflict.file);
        }
      }
      return { state, stopped: false };
    }

    if (selectedAction === 'regenerate-rebase') {
      publishWarning(
        bus,
        state.phase,
        'User edit conflict needs regenerate/rebase; workflow paused so the plan or task can be revised against the current files.',
      );
    }

    const issue = buildUserEditConflictRecoveryIssue({
      conflict,
      currentTask: task,
      phase: state.phase,
      createdAt: new Date().toISOString(),
    });
    state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PENDING_RECOVERY', issue });
    publishRecoveryPrompted(bus, issue);
    setTrackedState(state);
    return { state, stopped: true };
  } catch (err) {
    publishWarning(bus, state.phase, labelError('Failed to check user edit conflicts', err));
  }
  const issue = buildUserEditConflictRecoveryIssue({
    conflict: {
      kind: 'current-task-conflict',
      files: [],
      affectedTaskIds: [task.id],
      currentTaskId: task.id,
      fileConflicts: [],
      safeToContinue: false,
      availableActions: ['regenerate-rebase', 'pause', 'skip-current-task', 'abort-workflow'],
    },
    currentTask: task,
    phase: state.phase,
    createdAt: new Date().toISOString(),
  });
  state = transitionAndSave(projectDir, sessionId, state, { type: 'SET_PENDING_RECOVERY', issue });
  publishRecoveryPrompted(bus, issue);
  setTrackedState(state);
  return { state, stopped: true };
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
  return factory(opts.taskConfig);
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
        pricingCache: modelCacheStore,
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
