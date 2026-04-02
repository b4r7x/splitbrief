import type { Phase, TuiEvent, SidebarTask } from '../types.js';

export const MAX_EVENTS = 10_000;

export interface HookWorkflowState {
  events: TuiEvent[];
  phase: Phase;
  currentTask: number;
  totalTasks: number;
  localCount: number;
  escalatedCount: number;
  reviewFilePath: string | null;
  taskMap: Map<string, SidebarTask>;
}

export type WorkflowAction =
  | { type: 'ADD_EVENT'; event: TuiEvent }
  | { type: 'SET_REVIEW_FILE'; path: string | null };

export function workflowReducer(state: HookWorkflowState, action: WorkflowAction): HookWorkflowState {
  switch (action.type) {
    case 'ADD_EVENT': {
      const next = [...state.events, action.event];
      const events = next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
      let { phase, currentTask, totalTasks, localCount, escalatedCount } = state;
      if (action.event.type === 'planner-status') phase = action.event.phase as Phase;
      if (action.event.type === 'task-start') {
        currentTask = action.event.index + 1;
        totalTasks = action.event.total;
      }
      if (action.event.type === 'task-complete') {
        if (action.event.method === 'local') localCount += 1;
        else escalatedCount += 1;
      }
      let taskMap = state.taskMap;
      if (action.event.type === 'task-start') {
        taskMap = new Map(taskMap);
        taskMap.set(action.event.taskId, { id: action.event.taskId, title: action.event.title, status: 'in_progress' });
      } else if (action.event.type === 'task-complete' || action.event.type === 'task-skipped') {
        const status = action.event.type === 'task-complete' ? 'done' : 'skipped';
        const existing = taskMap.get(action.event.taskId);
        if (existing) {
          taskMap = new Map(taskMap);
          taskMap.set(action.event.taskId, { ...existing, status });
        }
      }
      return { ...state, events, phase, currentTask, totalTasks, localCount, escalatedCount, taskMap };
    }
    case 'SET_REVIEW_FILE':
      return { ...state, reviewFilePath: action.path };
  }
}
