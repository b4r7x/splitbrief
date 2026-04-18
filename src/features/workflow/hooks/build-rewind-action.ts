import type { StateAction } from '../../../core/types/state-actions.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { taskId } from '../../../core/schemas/task.js';
import type { TuiEvent } from '../types.js';
import type { RewindTarget } from '../handlers.js';
import { appendEvent } from '../../../core/state/persistence.js';

export interface RewindOutcome {
  action: StateAction;
  event: TuiEvent;
}

export function buildRewindAction(
  request: RewindTarget,
  projectDir: string,
  activeSessionId: string,
  current: WorkflowState,
): RewindOutcome {
  if (request.target === 'spec') {
    const data = request.comment ? { comment: request.comment } : {};
    appendEvent(projectDir, activeSessionId, {
      ts: Date.now(), type: 'rewind_to_spec', taskId: undefined,
      phase: current.phase, data,
    });
    return {
      action: { type: 'REWIND_TO_SPEC', ...(request.comment ? { comment: request.comment } : {}) },
      event: { type: 'rewind', ts: Date.now(), target: 'spec', comment: request.comment },
    };
  }
  if (request.target === 'plan') {
    const data = request.comment ? { comment: request.comment } : {};
    appendEvent(projectDir, activeSessionId, {
      ts: Date.now(), type: 'rewind_to_plan', taskId: undefined,
      phase: current.phase, data,
    });
    return {
      action: { type: 'REWIND_TO_PLAN', ...(request.comment ? { comment: request.comment } : {}) },
      event: { type: 'rewind', ts: Date.now(), target: 'plan', comment: request.comment },
    };
  }
  const tid = taskId(request.taskId);
  appendEvent(projectDir, activeSessionId, {
    ts: Date.now(), type: 'task_reset', taskId: tid,
    phase: current.phase, data: { taskId: request.taskId },
  });
  return {
    action: { type: 'RESET_TASK', taskId: tid },
    event: { type: 'task-reset', ts: Date.now(), taskId: tid },
  };
}
