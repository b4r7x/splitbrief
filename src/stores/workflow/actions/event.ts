import type { EngineEvent } from '../../../engine/events/types.js';
import {
  lifecycleStore,
  _lifecycleInternal,
  updatePhase,
  updateQueueDepth,
  updateStall,
  type LifecycleState,
} from '../lifecycle.js';
import { _eventsInternal, mergeEvent, projectEventForTuiEventLog } from '../events.js';
import { _tasksInternal, updateTaskCounts, updateTaskMap, type TasksState } from '../tasks.js';
import { _tokensInternal, updateTokens } from '../tokens.js';
import { _operationsInternal } from '../operations/state.js';
import { updateOperations } from '../operations/reducer.js';

export function addEvent(event: EngineEvent): void {
  if (event.type === 'cost_update') {
    _tokensInternal.set((s) => updateTokens(s, event));
    return;
  }

  if (lifecycleStore.get().cancelled && !acceptsEventAfterCancellation(event)) return;

  const eventForLog = projectEventForTuiEventLog(event);
  if (eventForLog !== null) {
    _eventsInternal.set((s) => ({ ...s, events: mergeEvent(s.events, eventForLog) }));
  }

  _tasksInternal.set((s) => reduceTasks(s, event));

  _tokensInternal.set((s) => updateTokens(s, event));

  _lifecycleInternal.set((s) => reduceLifecycle(s, event));

  _operationsInternal.set((s) => updateOperations(s, event));
}

export function reduceTasks(state: TasksState, event: EngineEvent): TasksState {
  const taskMap = updateTaskMap(state.taskMap, event);
  const tasks = taskMap !== state.taskMap ? Array.from(taskMap.values()) : state.tasks;
  const counts = updateTaskCounts(state, event, tasks);
  if (
    taskMap === state.taskMap &&
    tasks === state.tasks &&
    counts.currentTask === state.currentTask &&
    counts.currentAttempt === state.currentAttempt &&
    counts.totalTasks === state.totalTasks
  ) {
    return state;
  }
  return { ...state, ...counts, taskMap, tasks };
}

export function reduceLifecycle(state: LifecycleState, event: EngineEvent): LifecycleState {
  const afterPhase = updatePhase(state, event);
  const afterQueue = updateQueueDepth(afterPhase, event);
  return updateStall(afterQueue, event);
}

function acceptsEventAfterCancellation(event: EngineEvent): boolean {
  switch (event.type) {
    case 'workflow_cancelled':
    case 'turn_interrupted':
    case 'review_completed':
    case 'runner_call_error':
    case 'runner_call_completed':
    case 'runner_call_warning':
    case 'runner_call_usage':
    case 'runner_call_session_id':
    case 'runner_call_artifact':
      return true;
    default:
      return false;
  }
}
