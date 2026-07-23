import type { EngineEvent } from '../../../engine/events/types.js';
import { lifecycleStore } from '../lifecycle.js';
import { _eventsInternal, mergeEvent, projectEventForTuiEventLog } from '../events.js';
import { _tasksInternal, updateTaskCounts, updateTaskMap } from '../tasks.js';
import { _tokensInternal, updateTokens } from '../tokens.js';
import { _lifecycleInternal, updatePhase, updateQueueDepth, updateStall } from '../lifecycle.js';
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
    const afterQueue = updateQueueDepth(afterPhase, event);
    return updateStall(afterQueue, event);
  });

  _operationsInternal.set((s) => updateOperations(s, event));
}

function acceptsEventAfterCancellation(event: EngineEvent): boolean {
  switch (event.type) {
    case 'workflow_cancelled':
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
