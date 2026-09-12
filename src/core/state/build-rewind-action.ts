import type { StateAction } from './types.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { taskId } from '../schemas/task.js';
import type { SessionRef } from '../types/session-ref.js';
import { appendProtectedEngineEvent } from '../sessions/log-writer.js';
import { RewindEventSchema, type RewindEvent } from './rewind-event.js';

export type RewindTarget =
  | { target: 'spec'; comment?: string }
  | { target: 'plan'; comment?: string }
  | { target: 'task'; taskId: string };

export interface RewindOutcome {
  action: StateAction;
  event: RewindEvent;
}

export interface BuildRewindActionOptions {
  request: RewindTarget;
  ref: SessionRef;
  state: WorkflowState;
  persistEvent?: boolean | undefined;
}

export function buildRewindAction({
  request,
  ref,
  state,
  persistEvent = true,
}: BuildRewindActionOptions): RewindOutcome {
  if (request.target === 'spec') {
    const event: RewindEvent = {
      ts: Date.now(),
      type: 'rewind_to_spec',
      phase: state.phase,
      ...(request.comment ? { comment: request.comment } : {}),
    };
    if (persistEvent) appendRewindEvent(ref, event);
    const action: StateAction = {
      type: 'REWIND_TO_SPEC',
      ...(request.comment ? { comment: request.comment } : {}),
    };
    return { action, event };
  }
  if (request.target === 'plan') {
    const event: RewindEvent = {
      ts: Date.now(),
      type: 'rewind_to_plan',
      phase: state.phase,
      ...(request.comment ? { comment: request.comment } : {}),
    };
    if (persistEvent) appendRewindEvent(ref, event);
    const action: StateAction = {
      type: 'REWIND_TO_PLAN',
      ...(request.comment ? { comment: request.comment } : {}),
    };
    return { action, event };
  }
  const tid = taskId(request.taskId);
  const event: RewindEvent = {
    ts: Date.now(),
    type: 'task_reset',
    taskId: tid,
    phase: state.phase,
  };
  if (persistEvent) appendRewindEvent(ref, event);
  const action: StateAction = { type: 'RESET_TASK', taskId: tid };
  return { action, event };
}

function appendRewindEvent(ref: SessionRef, event: RewindEvent): void {
  appendProtectedEngineEvent(ref, event, RewindEventSchema);
}
