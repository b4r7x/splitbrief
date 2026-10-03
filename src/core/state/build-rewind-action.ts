import type { StateAction } from './types.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { taskId } from '../schemas/task.js';
import type { RewindEvent } from './rewind-event.js';

export type TaskRedoRequest = { target: 'task'; taskId: string };

export interface RewindOutcome {
  action: StateAction;
  event: RewindEvent;
}

export function buildRewindAction({
  request,
  state,
}: {
  request: TaskRedoRequest;
  state: WorkflowState;
}): RewindOutcome {
  const tid = taskId(request.taskId);
  const event: RewindEvent = {
    ts: Date.now(),
    type: 'task_reset',
    taskId: tid,
    phase: state.phase,
  };
  const action: StateAction = { type: 'RESET_TASK', taskId: tid };
  return { action, event };
}
