import { groupEventsIntoSections } from '../../core/layout/event-sections.js';
import type { Section } from '../../core/layout/event-sections.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { abortStore } from './abort.js';
import { _eventsInternal, eventsStore, mergeEvent, type EventsState } from './events.js';
import { _tasksInternal, tasksStore, updateTaskCounts, updateTaskMap, type TasksState } from './tasks.js';
import { _tokensInternal, tokensStore, updateTokens, type TokensState } from './tokens.js';
import { _lifecycleInternal, lifecycleStore, updatePhase, updateQueueDepth, type LifecycleState } from './lifecycle.js';

export type WorkflowViewState = EventsState & TasksState & TokensState & LifecycleState;

export function addEvent(event: EngineEvent): void {
  // Cancelled gate: dispatcher policy — sub-stores are passive containers.
  if (lifecycleStore.get().cancelled) return;

  // Fast path: cost_update only touches token state, but still needs the
  // reducer so per-phase cost/cache telemetry stays in sync.
  if (event.type === 'cost_update') {
    _tokensInternal.set(s => updateTokens(s, event));
    return;
  }

  // Ordering invariant: events → tasks → tokens → lifecycle.
  // Strictly synchronous — no await, no setTimeout, no microtask scheduling.
  // React 19 + Ink batch synchronous store updates so subscribers observe one
  // consistent commit with all four stores updated.
  _eventsInternal.set(s => ({ ...s, events: mergeEvent(s.events, event) }));

  _tasksInternal.set(s => {
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

  _tokensInternal.set(s => updateTokens(s, event));

  _lifecycleInternal.set(s => {
    const afterPhase = updatePhase(s, event);
    return updateQueueDepth(afterPhase, event);
  });
}

export function markCancelled(): boolean {
  const lifecycle = lifecycleStore.get();
  if (lifecycle.cancelled) return false;
  const now = Date.now();
  const phase = lifecycle.phase;
  _eventsInternal.set(s => {
    const rewritten = s.events.map(ev =>
      ev.type === 'planner_status' && ev.status === 'running'
        ? { ...ev, status: 'done' as const }
        : ev,
    );
    return { events: [...rewritten, { type: 'workflow_cancelled' as const, ts: now, phase }] };
  });
  _lifecycleInternal.set(s => ({ ...s, cancelled: true }));
  return true;
}

export function resetWorkflow(resume?: WorkflowState): void {
  // Must come first — preserves prior contract (current workflow.ts:98 behaviour).
  abortStore.clear();
  eventsStore.reset();
  tasksStore.reset();
  tokensStore.reset();
  lifecycleStore.reset();
  cachedEvents = null;
  cachedSections = [];
  if (resume) {
    _lifecycleInternal.set(s => ({ ...s, phase: resume.phase }));
    _tasksInternal.set(s => ({
      ...s,
      currentTask: resume.currentTaskIndex ?? 0,
      totalTasks: resume.tasks?.length ?? 0,
    }));
  }
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
  const events = eventsStore.use(s => s.events);
  return computeSections(events);
}
