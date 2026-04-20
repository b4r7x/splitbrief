import type { StateAction } from '../../../core/types/state-actions.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { taskId } from '../../../core/schemas/task.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { RewindTarget } from '../handlers.js';
import { appendEngineEvent } from '../../../core/state/persistence.js';

export interface RewindOutcome {
  action: StateAction;
  event: EngineEvent;
}

export function buildRewindAction(
  request: RewindTarget,
  projectDir: string,
  activeSessionId: string,
  current: WorkflowState,
): RewindOutcome {
  if (request.target === 'spec') {
    const event: EngineEvent = {
      ts: Date.now(), type: 'rewind_to_spec',
      phase: current.phase, ...(request.comment ? { comment: request.comment } : {}),
    };
    appendEngineEvent(projectDir, activeSessionId, event);
    return {
      action: { type: 'REWIND_TO_SPEC', ...(request.comment ? { comment: request.comment } : {}) },
      event,
    };
  }
  if (request.target === 'plan') {
    const event: EngineEvent = {
      ts: Date.now(), type: 'rewind_to_plan',
      phase: current.phase, ...(request.comment ? { comment: request.comment } : {}),
    };
    appendEngineEvent(projectDir, activeSessionId, event);
    return {
      action: { type: 'REWIND_TO_PLAN', ...(request.comment ? { comment: request.comment } : {}) },
      event,
    };
  }
  const tid = taskId(request.taskId);
  const event: EngineEvent = {
    ts: Date.now(), type: 'task_reset', taskId: tid,
    phase: current.phase,
  };
  appendEngineEvent(projectDir, activeSessionId, event);
  return {
    action: { type: 'RESET_TASK', taskId: tid },
    event,
  };
}
