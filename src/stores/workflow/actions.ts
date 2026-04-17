import { groupEventsIntoSections } from '../../core/layout/event-sections.js';
import type { Section } from '../../core/layout/event-sections.js';
import type { WorkflowState } from '../../core/types/state-actions.js';
import type { TuiEvent } from '../../features/workflow/types.js';
import { abortStore } from './abort.js';
import { eventsStore, mergeEvent, type EventsState } from './events.js';
import { tasksStore, updateTaskCounts, updateTaskMap, type TasksState } from './tasks.js';
import { tokensStore, updateTokens, type TokensState } from './tokens.js';
import { lifecycleStore, updatePhase, updateQueueDepth, type LifecycleState } from './lifecycle.js';

export type WorkflowViewState = EventsState & TasksState & TokensState & LifecycleState;

export function addEvent(event: TuiEvent): void {
  // Cancelled gate: dispatcher policy — sub-stores are passive containers.
  if (lifecycleStore.get().cancelled) return;

  // Fast path: cost-update only touches tokenUsage.
  if (event.type === 'cost-update') {
    tokensStore.set(s => ({ ...s, tokenUsage: event.tokenUsage }));
    return;
  }

  // Ordering invariant: events → tasks → tokens → lifecycle.
  // Strictly synchronous — no await, no setTimeout, no microtask scheduling.
  // React 19 + Ink batch synchronous store updates so subscribers observe one
  // consistent commit with all four stores updated.
  eventsStore.set(s => ({ ...s, events: mergeEvent(s.events, event) }));

  tasksStore.set(s => {
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

  tokensStore.set(s => updateTokens(s, event));

  lifecycleStore.set(s => {
    const afterPhase = updatePhase(s, event);
    return updateQueueDepth(afterPhase, event);
  });
}

export function markCancelled(): boolean {
  if (lifecycleStore.get().cancelled) return false;
  const now = Date.now();
  eventsStore.set(s => {
    const rewritten = s.events.map(ev =>
      ev.type === 'planner-status' && ev.status === 'running'
        ? { ...ev, status: 'done' as const }
        : ev,
    );
    return { events: [...rewritten, { type: 'workflow-cancelled' as const, ts: now }] };
  });
  lifecycleStore.set(s => ({ ...s, cancelled: true }));
  return true;
}

export function resetWorkflow(resume?: WorkflowState): void {
  // Must come first — preserves prior contract (current workflow.ts:98 behaviour).
  abortStore.clear();
  eventsStore.reset();
  tasksStore.reset();
  tokensStore.reset();
  lifecycleStore.reset();
  if (resume) {
    lifecycleStore.set(s => ({ ...s, phase: resume.phase }));
    tasksStore.set(s => ({
      ...s,
      currentTask: resume.currentTaskIndex ?? 0,
      totalTasks: resume.tasks?.length ?? 0,
    }));
  }
}

let cachedEvents: TuiEvent[] | null = null;
let cachedSections: Section[] = [];

function computeSections(events: TuiEvent[]): Section[] {
  if (cachedEvents === events) return cachedSections;
  cachedEvents = events;
  cachedSections = groupEventsIntoSections(events);
  return cachedSections;
}

export function getSections(): Section[] {
  return computeSections(eventsStore.get().events);
}

export function useSections(): Section[] {
  const events = eventsStore.use(s => s.events);
  return computeSections(events);
}
