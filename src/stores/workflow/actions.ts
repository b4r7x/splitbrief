import { groupEventsIntoSections } from '../../core/sections/event-sections.js';
import type { Section } from '../../core/sections/event-sections.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { abortStore } from './abort.js';
import { closeApprovalPrompt } from '../approval-prompt/prompt.js';
import { closeCostApprovalPrompt } from '../cost-approval/prompt.js';
import { _eventsInternal, eventsStore, mergeEvent } from './events.js';
import {
  _tasksInternal,
  tasksStore,
  updateTaskCounts,
  updateTaskMap,
  type TasksState,
  type WorkflowTask,
} from './tasks.js';
import {
  _tokensInternal,
  tokensStore,
  updateTokens,
  type PerTaskTokens,
  type TokensState,
} from './tokens.js';
import { _lifecycleInternal, lifecycleStore, updatePhase, updateQueueDepth } from './lifecycle.js';
import { streamingOutputStore } from './streaming-output.js';

export function addEvent(event: EngineEvent): void {
  // Cancelled gate: dispatcher policy — sub-stores are passive containers.
  if (lifecycleStore.get().cancelled) return;

  // Fast path: cost_update only touches token state, but still needs the
  // reducer so per-phase cost/cache telemetry stays in sync.
  if (event.type === 'cost_update') {
    _tokensInternal.set((s) => updateTokens(s, event));
    return;
  }

  // Ordering invariant: events → tasks → tokens → lifecycle.
  // Strictly synchronous — no await, no setTimeout, no microtask scheduling.
  // React 19 + Ink batch synchronous store updates so subscribers observe one
  // consistent commit with all four stores updated.
  _eventsInternal.set((s) => ({ ...s, events: mergeEvent(s.events, event) }));

  _tasksInternal.set((s) => {
    const taskMap = updateTaskMap(s.taskMap, event);
    const counts = updateTaskCounts(s, event);
    const tasks = taskMap !== s.taskMap ? Array.from(taskMap.values()) : s.tasks;
    if (
      taskMap === s.taskMap &&
      tasks === s.tasks &&
      counts.currentTask === s.currentTask &&
      counts.totalTasks === s.totalTasks &&
      counts.taskCompletionTimes === s.taskCompletionTimes
    ) {
      return s;
    }
    return { ...s, ...counts, taskMap, tasks };
  });

  _tokensInternal.set((s) => updateTokens(s, event));

  _lifecycleInternal.set((s) => {
    const afterPhase = updatePhase(s, event);
    return updateQueueDepth(afterPhase, event);
  });
}

export function markCancelled(): boolean {
  const lifecycle = lifecycleStore.get();
  if (lifecycle.cancelled) return false;
  const now = Date.now();
  const phase = lifecycle.phase;
  _eventsInternal.set((s) => {
    const rewritten = s.events.map((ev) =>
      ev.type === 'planner_status' && ev.status === 'running'
        ? { ...ev, status: 'done' as const }
        : ev,
    );
    return {
      events: mergeEvent(rewritten, { type: 'workflow_cancelled' as const, ts: now, phase }),
    };
  });
  _lifecycleInternal.set((s) => ({ ...s, cancelled: true }));
  return true;
}

export function resetWorkflow(resume?: WorkflowState): void {
  // Must come first — preserves prior contract (current workflow.ts:98 behaviour).
  abortStore.clear();
  closeApprovalPrompt();
  closeCostApprovalPrompt({ approved: false });
  eventsStore.reset();
  tasksStore.reset();
  tokensStore.reset();
  lifecycleStore.reset();
  streamingOutputStore.reset();
  cachedEvents = null;
  cachedSections = [];
  if (resume) {
    _lifecycleInternal.set((s) => ({
      ...s,
      phase: resume.phase,
      queueDepth: resume.messageQueue.filter((m) => !m.drainedAt).length,
    }));
    _tasksInternal.set((s) => ({ ...s, ...tasksStateFromResume(resume) }));
    _tokensInternal.set((s) => ({ ...s, ...tokensStateFromResume(resume) }));
  }
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
  return {
    localCount: resume.tasks.filter((task) => task.status === 'done').length,
    escalatedCount: resume.tasks.filter((task) => task.status === 'escalated').length,
    completedTaskCount: resume.tasks.filter(
      (task) => task.status !== 'pending' && task.status !== 'in_progress',
    ).length,
    tokenUsage: resume.tokenUsage,
    pricingContext: pricingContextFromResume(resume),
    perTask: perTaskFromResume(resume),
  };
}

function perTaskFromResume(resume: WorkflowState): Record<string, PerTaskTokens> {
  const perTask: Record<string, PerTaskTokens> = {};
  for (const breakdown of resume.taskBreakdowns ?? []) {
    const existing = perTask[breakdown.taskId] ?? {
      totalTokens: 0,
      title: breakdown.taskTitle,
      attempts: [],
    };
    const attempts = [
      ...(existing.attempts ?? []),
      {
        method: breakdown.method,
        implementerTokens: breakdown.implementerTokens,
        escalationTokens: breakdown.escalationTokens,
        retryCount: breakdown.retryCount,
        ...(breakdown.tool !== undefined && { tool: breakdown.tool }),
        ...(breakdown.model !== undefined && { model: breakdown.model }),
      },
    ];
    perTask[breakdown.taskId] = {
      title: breakdown.taskTitle,
      totalTokens: attempts.reduce((sum, a) => sum + a.implementerTokens + a.escalationTokens, 0),
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

let cachedEvents: EngineEvent[] | null = null;
let cachedSections: Section<EngineEvent>[] = [];

function computeSections(events: EngineEvent[]): Section<EngineEvent>[] {
  if (cachedEvents === events) return cachedSections;
  cachedEvents = events;
  cachedSections = groupEventsIntoSections(events);
  return cachedSections;
}

export function getSections(): Section<EngineEvent>[] {
  return computeSections(eventsStore.get().events);
}

export function useSections(): Section<EngineEvent>[] {
  const events = eventsStore.use((s) => s.events);
  return computeSections(events);
}
