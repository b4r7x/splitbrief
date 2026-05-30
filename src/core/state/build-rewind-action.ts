import type { StateAction } from './types.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { taskId } from '../schemas/task.js';
import type { TaskId } from '../schemas/task.js';
import type { Phase } from '../schemas/enums.js';
import { appendEngineEvent } from './persistence.js';

export type RewindTarget =
  | { target: 'spec'; comment?: string }
  | { target: 'plan'; comment?: string }
  | { target: 'task'; taskId: string };

export type RewindEvent =
  | { type: 'rewind_to_spec'; ts: number; phase: Phase; comment?: string }
  | { type: 'rewind_to_plan'; ts: number; phase: Phase; comment?: string }
  | { type: 'task_reset'; ts: number; phase: Phase; taskId: TaskId };

export interface RewindOutcome {
  action: StateAction;
  event: RewindEvent;
}

export function buildRewindAction(
  request: RewindTarget,
  projectDir: string,
  activeSessionId: string,
  current: WorkflowState,
): RewindOutcome {
  if (request.target === 'spec') {
    const event: RewindEvent = {
      ts: Date.now(),
      type: 'rewind_to_spec',
      phase: current.phase,
      ...(request.comment ? { comment: request.comment } : {}),
    };
    appendEngineEvent(projectDir, activeSessionId, event);
    return {
      action: { type: 'REWIND_TO_SPEC', ...(request.comment ? { comment: request.comment } : {}) },
      event,
    };
  }
  if (request.target === 'plan') {
    const event: RewindEvent = {
      ts: Date.now(),
      type: 'rewind_to_plan',
      phase: current.phase,
      ...(request.comment ? { comment: request.comment } : {}),
    };
    appendEngineEvent(projectDir, activeSessionId, event);
    return {
      action: { type: 'REWIND_TO_PLAN', ...(request.comment ? { comment: request.comment } : {}) },
      event,
    };
  }
  const tid = taskId(request.taskId);
  const event: RewindEvent = {
    ts: Date.now(),
    type: 'task_reset',
    taskId: tid,
    phase: current.phase,
  };
  appendEngineEvent(projectDir, activeSessionId, event);
  return {
    action: { type: 'RESET_TASK', taskId: tid },
    event,
  };
}
