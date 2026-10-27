import { definedTaskUsageFields, TASK_USAGE_ATTEMPT_KEYS } from '../../../core/schemas/tokens.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { briefPosition } from '../../../core/state/selectors.js';
import { isQueuedMessagePendingFirstDelivery } from '../../../core/queue-state.js';
import { _tasksInternal, type TasksState, type WorkflowTask } from '../tasks.js';
import {
  _tokensInternal,
  taskAttemptTotalTokens,
  type PerTaskTokens,
  type TaskAttemptTokens,
  type TokensState,
} from '../tokens.js';
import { _lifecycleInternal, type LifecycleState } from '../lifecycle.js';

/**
 * The saved state, laid over the stores the replayed log already rebuilt. The log is the narrative
 * and the state is the record of where the run stands, so three facts come from the state and win:
 * the phase, the brief list, and what the run has spent. A run read back from disk is at rest — it
 * never claims to be running, whatever the last event on the log happened to be.
 */
export function hydrateFromState(state: WorkflowState): void {
  _lifecycleInternal.set((current) => lifecycleFromState(current, state));
  _tasksInternal.set((current) => ({ ...current, ...tasksStateFromState(state) }));
  _tokensInternal.set((current) => ({ ...current, ...tokensStateFromState(state) }));
}

function lifecycleFromState(current: LifecycleState, state: WorkflowState): LifecycleState {
  const startedAt = timestampFromIso(state.startedAt);
  const queuedMessageIds = new Set(
    state.messageQueue.filter(isQueuedMessagePendingFirstDelivery).map((message) => message.id),
  );
  const base = {
    interruptParked: false,
    cancelled: false,
    queueDepth: queuedMessageIds.size,
    queuedMessageIds,
    steerableCall: null,
    phaseFirstSeenTs: current.phaseFirstSeenTs,
    stall: null,
    seatWait: null,
    lastRunnerEventTs: current.lastRunnerEventTs ?? null,
    attemptStartedTs: current.attemptStartedTs ?? null,
    startedAt,
    reason: null,
    restored: true,
  } as const;
  if (state.phase === 'complete') {
    return {
      ...base,
      phase: state.phase,
      status: 'complete',
      endedAt: state.completedAt === undefined ? null : timestampFromIso(state.completedAt),
      durationMs: null,
    };
  }
  return { ...base, phase: state.phase, status: 'paused', endedAt: null, durationMs: null };
}

function tasksStateFromState(
  state: WorkflowState,
): Pick<TasksState, 'currentTask' | 'totalTasks' | 'taskMap' | 'tasks'> {
  const totalTasks = state.tasks.length;
  const currentTask = briefPosition(state)?.position ?? 0;
  const tasks = state.tasks.map<WorkflowTask>((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    file: task.suggestedFiles[0],
    action: task.action,
  }));
  const taskMap = new Map<string, WorkflowTask>();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }
  return {
    currentTask,
    totalTasks,
    taskMap,
    tasks,
  };
}

function tokensStateFromState(
  state: WorkflowState,
): Pick<TokensState, 'completedTaskCount' | 'tokenUsage' | 'passSeats' | 'perTask'> {
  return {
    completedTaskCount: state.tasks.filter(
      (task) => task.status !== 'pending' && task.status !== 'in_progress',
    ).length,
    tokenUsage: state.tokenUsage,
    passSeats: passSeats(state),
    perTask: perTaskTokens(state),
  };
}

function perTaskTokens(state: WorkflowState): Record<string, PerTaskTokens> {
  const perTask: Record<string, PerTaskTokens> = {};
  for (const breakdown of state.taskBreakdowns ?? []) {
    const attempt: TaskAttemptTokens = {
      method: breakdown.method,
      implementerTokens: breakdown.implementerTokens,
      escalationTokens: breakdown.escalationTokens,
      retryCount: breakdown.retryCount,
      ...definedTaskUsageFields(breakdown, TASK_USAGE_ATTEMPT_KEYS),
    };
    const attempts = [...(perTask[breakdown.taskId]?.attempts ?? []), attempt];
    perTask[breakdown.taskId] = {
      title: breakdown.taskTitle,
      totalTokens: attempts.reduce((sum, a) => sum + taskAttemptTotalTokens(a), 0),
      attempts,
    };
  }
  return perTask;
}

/** The saved state keeps no axis words, so the chrome does not take these seats as known. */
function passSeats(state: WorkflowState): TokensState['passSeats'] {
  if (!state.plannerTool || !state.implementerTool) return null;
  return {
    plannerTool: state.plannerTool,
    implementerTool: state.implementerTool,
    plannerModel: state.plannerModel,
    implementerModel: state.implementerModel,
    ...(state.reviewerTool !== undefined && {
      reviewerTool: state.reviewerTool,
      ...(state.reviewerModel !== undefined && { reviewerModel: state.reviewerModel }),
    }),
  };
}

function timestampFromIso(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
