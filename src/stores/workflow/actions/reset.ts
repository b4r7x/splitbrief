import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import { definedTaskUsageFields, TASK_USAGE_ATTEMPT_KEYS } from '../../../core/schemas/tokens.js';
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
import {
  _lifecycleInternal,
  durationFromStart,
  lifecycleStore,
  type LifecycleState,
} from '../lifecycle.js';
import { operationsStore } from '../operations/state.js';
import { recoveryNoticeStore } from '../recovery-notice.js';
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
  recoveryNoticeStore.reset();
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
    const endedAt = resume.completedAt === undefined ? null : timestampFromIso(resume.completedAt);
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
      durationMs: endedAt === null ? null : durationFromStart(startedAt, endedAt),
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

function pricingContextFromResume(resume: WorkflowState): TokensState['pricingContext'] {
  if (!resume.plannerTool || !resume.implementerTool) return null;
  return {
    plannerTool: resume.plannerTool,
    implementerTool: resume.implementerTool,
    plannerModel: resume.plannerModel,
    implementerModel: resume.implementerModel,
    ...(resume.reviewerTool !== undefined && {
      reviewerTool: resume.reviewerTool,
      ...(resume.reviewerModel !== undefined && { reviewerModel: resume.reviewerModel }),
    }),
  };
}

function timestampFromIso(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
