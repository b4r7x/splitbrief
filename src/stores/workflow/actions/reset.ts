import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import { classifyTaskCompletionMethod } from '../../../core/task-completion.js';
import { abortStore } from '../abort.js';
import { closeApprovalPrompt } from '../../approval-prompt/prompt.js';
import { closeCostApprovalPrompt } from '../../cost-approval/prompt.js';
import { eventsStore } from '../events.js';
import { _tasksInternal, tasksStore, type TasksState, type WorkflowTask } from '../tasks.js';
import {
  _tokensInternal,
  taskAttemptTotalTokens,
  tokensStore,
  type PerTaskTokens,
  type TaskAttemptTokens,
  type TokensState,
} from '../tokens.js';
import { _lifecycleInternal, lifecycleStore, type LifecycleState } from '../lifecycle.js';
import { operationsStore } from '../operations/state.js';
import { streamingOutputStore } from '../streaming-output.js';
import { clearSectionsCache } from './sections.js';

export function resetWorkflow(resume?: WorkflowState): void {
  abortStore.clear();
  closeApprovalPrompt();
  closeCostApprovalPrompt({ approved: false });
  eventsStore.reset();
  tasksStore.reset();
  tokensStore.reset();
  lifecycleStore.reset();
  operationsStore.reset();
  streamingOutputStore.reset();
  clearSectionsCache();
  if (resume) {
    _lifecycleInternal.set(lifecycleStateFromResume(resume));
    _tasksInternal.set((s) => ({ ...s, ...tasksStateFromResume(resume) }));
    _tokensInternal.set((s) => ({ ...s, ...tokensStateFromResume(resume) }));
  }
}

function lifecycleStateFromResume(resume: WorkflowState): LifecycleState {
  const startedAt = timestampFromIso(resume.startedAt);
  const pendingMessages = pendingQueueMessages(resume.messageQueue);
  const queueDepth = pendingMessages.length;
  if (resume.phase === 'complete') {
    const endedAt = startedAt ?? Date.now();
    return {
      phase: resume.phase,
      status: 'complete',
      interruptParked: false,
      cancelled: false,
      queueDepth,
      phaseFirstSeenTs: {},
      stall: null,
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - (startedAt ?? endedAt)),
      reason: null,
    };
  }
  return {
    phase: resume.phase,
    status: 'running',
    interruptParked: false,
    cancelled: false,
    queueDepth,
    phaseFirstSeenTs: {},
    stall: null,
    startedAt,
    endedAt: null,
    durationMs: null,
    reason: null,
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

function tasksStateFromResume(
  resume: WorkflowState,
): Pick<TasksState, 'currentTask' | 'totalTasks' | 'taskMap' | 'tasks'> {
  const totalTasks = resume.tasks.length;
  const currentTask =
    totalTasks === 0 ? 0 : Math.min(Math.max(0, resume.currentTaskIndex) + 1, totalTasks);
  const tasks = resume.tasks.map<WorkflowTask>((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    file: task.file,
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

function tokensStateFromResume(
  resume: WorkflowState,
): Pick<
  TokensState,
  | 'localCount'
  | 'escalatedCount'
  | 'completedTaskCount'
  | 'tokenUsage'
  | 'pricingContext'
  | 'perTask'
> {
  const counts = completionCountsFromResume(resume);
  return {
    localCount: counts.local,
    escalatedCount: counts.escalated,
    completedTaskCount: resume.tasks.filter(
      (task) => task.status !== 'pending' && task.status !== 'in_progress',
    ).length,
    tokenUsage: resume.tokenUsage,
    pricingContext: pricingContextFromResume(resume),
    perTask: perTaskFromResume(resume),
  };
}

function completionCountsFromResume(resume: WorkflowState): { local: number; escalated: number } {
  const latestMethodByTask = new Map<string, TaskCompletionMethod>();
  for (const breakdown of resume.taskBreakdowns ?? []) {
    latestMethodByTask.set(breakdown.taskId, breakdown.method);
  }

  let local = 0;
  let escalated = 0;
  for (const task of resume.tasks) {
    if (task.status !== 'done' && task.status !== 'escalated') continue;
    const method = latestMethodByTask.get(task.id);
    if (method) {
      const completionClass = classifyTaskCompletionMethod(method);
      if (completionClass === 'local') local += 1;
      else if (completionClass === 'escalated') escalated += 1;
      continue;
    }
    if (task.status === 'done') local += 1;
    else escalated += 1;
  }
  return { local, escalated };
}

function perTaskFromResume(resume: WorkflowState): Record<string, PerTaskTokens> {
  const perTask: Record<string, PerTaskTokens> = {};
  for (const breakdown of resume.taskBreakdowns ?? []) {
    const existing = perTask[breakdown.taskId] ?? {
      totalTokens: 0,
      title: breakdown.taskTitle,
      attempts: [],
    };
    const attempt: TaskAttemptTokens = {
      method: breakdown.method,
      implementerTokens: breakdown.implementerTokens,
      escalationTokens: breakdown.escalationTokens,
      retryCount: breakdown.retryCount,
      ...(breakdown.implementerCacheReadTokens !== undefined && {
        implementerCacheReadTokens: breakdown.implementerCacheReadTokens,
      }),
      ...(breakdown.implementerCacheCreateTokens !== undefined && {
        implementerCacheCreateTokens: breakdown.implementerCacheCreateTokens,
      }),
      ...(breakdown.escalationCacheReadTokens !== undefined && {
        escalationCacheReadTokens: breakdown.escalationCacheReadTokens,
      }),
      ...(breakdown.escalationCacheCreateTokens !== undefined && {
        escalationCacheCreateTokens: breakdown.escalationCacheCreateTokens,
      }),
      ...(breakdown.tool !== undefined && { tool: breakdown.tool }),
      ...(breakdown.model !== undefined && { model: breakdown.model }),
      ...(breakdown.implementerProfile !== undefined && {
        implementerProfile: breakdown.implementerProfile,
      }),
      ...(breakdown.contextFit !== undefined && { contextFit: breakdown.contextFit }),
      ...(breakdown.estimatedTokens !== undefined && {
        estimatedTokens: breakdown.estimatedTokens,
      }),
      ...(breakdown.untruncatedEstimatedTokens !== undefined && {
        untruncatedEstimatedTokens: breakdown.untruncatedEstimatedTokens,
      }),
      ...(breakdown.contextLength !== undefined && { contextLength: breakdown.contextLength }),
      ...(breakdown.currentCodeTruncated !== undefined && {
        currentCodeTruncated: breakdown.currentCodeTruncated,
      }),
      ...(breakdown.currentCodeContextMode !== undefined && {
        currentCodeContextMode: breakdown.currentCodeContextMode,
      }),
      ...(breakdown.costPosture !== undefined && { costPosture: breakdown.costPosture }),
      ...(breakdown.routingReason !== undefined && { routingReason: breakdown.routingReason }),
    };
    const attempts = [...(existing.attempts ?? []), attempt];
    perTask[breakdown.taskId] = {
      title: breakdown.taskTitle,
      totalTokens: attempts.reduce((sum, a) => sum + taskAttemptTotalTokens(a), 0),
      attempts,
    };
  }
  return perTask;
}

function pricingContextFromResume(resume: WorkflowState): TokensState['pricingContext'] {
  if (!resume.plannerTool || !resume.implementerTool) return null;
  return {
    plannerTool: resume.plannerTool,
    implementerTool: resume.implementerTool,
    plannerModel: resume.plannerModel,
    implementerModel: resume.implementerModel,
  };
}

function timestampFromIso(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
