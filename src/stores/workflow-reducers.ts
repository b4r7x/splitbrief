import type { SidebarTask, TuiEvent } from '../types.js';
import type { WorkflowViewState } from './workflow.js';


export const MAX_EVENTS = 10_000;

export function mergeEvent(events: TuiEvent[], event: TuiEvent): TuiEvent[] {
  const last = events[events.length - 1];
  if (event.type === 'planner-text' && last?.type === 'planner-text') {
    const merged = { ...last, text: last.text + event.text };
    const next = events.slice();
    next[next.length - 1] = merged;
    return next;
  }
  if (event.type === 'validate' && event.status === 'running' && last?.type === 'validate' && last.status === 'running') {
    const next = events.slice();
    next[next.length - 1] = event;
    return next;
  }
  if (events.length >= MAX_EVENTS) {
    return [...events.slice(1), event];
  }
  return [...events, event];
}

export function updateCounts(
  state: WorkflowViewState,
  event: TuiEvent,
): Pick<WorkflowViewState, 'phase' | 'currentTask' | 'totalTasks' | 'localCount' | 'escalatedCount' | 'taskCompletionTimes'> {
  let { phase, currentTask, totalTasks, localCount, escalatedCount, taskCompletionTimes } = state;
  if (event.type === 'planner-status') phase = event.phase;
  if (event.type === 'task-start') {
    currentTask = event.index + 1;
    totalTasks = event.total;
  }
  if (event.type === 'task-complete') {
    taskCompletionTimes = [...taskCompletionTimes, event.duration];
    if (event.method === 'local') localCount += 1;
    else if (event.method === 'escalated-intermediate' || event.method === 'escalated-hint' || event.method === 'escalated-full') escalatedCount += 1;
  }
  return { phase, currentTask, totalTasks, localCount, escalatedCount, taskCompletionTimes };
}

export function updateTaskMap(
  taskMap: Map<string, SidebarTask>,
  event: TuiEvent,
): Map<string, SidebarTask> {
  if (event.type === 'task-start') {
    const next = new Map(taskMap);
    next.set(event.taskId, { id: event.taskId, title: event.title, status: 'in_progress' });
    return next;
  }
  if (event.type === 'task-complete' || event.type === 'task-skipped') {
    const status = event.type === 'task-complete' ? 'done' : 'skipped';
    const existing = taskMap.get(event.taskId);
    if (!existing || existing.status === status) return taskMap;
    const next = new Map(taskMap);
    next.set(event.taskId, { ...existing, status });
    return next;
  }
  return taskMap;
}
