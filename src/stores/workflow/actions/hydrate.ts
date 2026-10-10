import { definedTaskUsageFields, TASK_USAGE_ATTEMPT_KEYS } from '../../../core/schemas/tokens.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import { _tasksInternal, type TasksState, type WorkflowTask } from '../tasks.js';
import {
  _tokensInternal,
  taskAttemptTotalTokens,
  type PerTaskTokens,
  type TaskAttemptTokens,
  type TokensState,
} from '../tokens.js';
import { _lifecycleInternal, runMsAt, type LifecycleState } from '../lifecycle.js';

export interface HydrateFromStateOptions {
  /** When the run last produced an event, so a run at rest shows a clock that stopped. */
  endedAt?: number | null | undefined;
}

/**
 * The saved state, laid over the stores the replayed log already rebuilt. The log is the narrative
 * and the state is the record of where the run stands, so three facts come from the state and win:
 * the phase, the brief list, and what the run has spent. A run read back from disk is at rest — it
 * never claims to be running, whatever the last event on the log happened to be.
 */
export function hydrateFromState(
  state: WorkflowState,
  options: HydrateFromStateOptions = {},
): void {
  const endedAt = options.endedAt ?? null;
  _lifecycleInternal.set((current) => lifecycleFromState(current, state, endedAt));
  _tasksInternal.set((current) => ({ ...current, ...tasksStateFromState(state) }));
  _tokensInternal.set((current) => ({ ...current, ...tokensStateFromState(state) }));
}

function lifecycleFromState(
  current: LifecycleState,
  state: WorkflowState,
  lastEventTs: number | null,
): LifecycleState {
  const startedAt = timestampFromIso(state.startedAt);
  const queueDepth = pendingQueueMessages(state.messageQueue).length;
  const base = {
    interruptParked: false,
    cancelled: false,
    queueDepth,
    phaseFirstSeenTs: current.phaseFirstSeenTs,
    stall: null,
    lastRunnerEventTs: current.lastRunnerEventTs ?? null,
    attemptStartedTs: current.attemptStartedTs ?? null,
    startedAt,
    reason: null,
  } as const;
  // The replayed log knows the stretches the run ran and the parks between them; the state knows
  // only when it started. A log with no start of its own runs from the state's.
  const runMsUntil = (ts: number | null): number | null => {
    if (ts === null) return null;
    if (current.startedAt === null) return Math.max(0, ts - (startedAt ?? ts));
    return current.durationMs ?? runMsAt(current, ts);
  };
  if (state.phase === 'complete') {
    const completedAt =
      state.completedAt === undefined ? lastEventTs : timestampFromIso(state.completedAt);
    return {
      ...base,
      phase: state.phase,
      status: 'complete',
      endedAt: completedAt,
      durationMs: runMsUntil(completedAt),
    };
  }
  return {
    ...base,
    phase: state.phase,
    status: 'paused',
    endedAt: null,
    durationMs: runMsUntil(lastEventTs),
  };
}

function pendingQueueMessages(messages: readonly QueuedMessage[]): QueuedMessage[] {
  return messages.filter(
    (message) =>
      !message.drainedAt &&
      !message.deliveredViaNative &&
      message.nativeDeliveryState !== 'delivered' &&
      message.nativeDeliveryState !== 'injecting',
  );
}

function tasksStateFromState(
  state: WorkflowState,
): Pick<TasksState, 'currentTask' | 'totalTasks' | 'taskMap' | 'tasks'> {
  const totalTasks = state.tasks.length;
  const currentTask =
    totalTasks === 0 ? 0 : Math.min(Math.max(0, state.currentTaskIndex) + 1, totalTasks);
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
): Pick<TokensState, 'completedTaskCount' | 'tokenUsage' | 'pricingContext' | 'perTask'> {
  return {
    completedTaskCount: state.tasks.filter(
      (task) => task.status !== 'pending' && task.status !== 'in_progress',
    ).length,
    tokenUsage: state.tokenUsage,
    pricingContext: pricingContext(state),
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

function pricingContext(state: WorkflowState): TokensState['pricingContext'] {
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
