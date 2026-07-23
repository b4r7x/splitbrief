import type { StateAction } from './types.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { taskId } from '../schemas/task.js';
import type { SessionRef } from '../types/session-ref.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../transcript-policy.js';
import { appendProtectedEngineEvent } from '../sessions/log-writer.js';
import { RewindEventSchema, type RewindEvent } from './rewind-event.js';

export type RewindTarget =
  | { target: 'spec'; comment?: string }
  | { target: 'plan'; comment?: string }
  | { target: 'task'; taskId: string };

export interface RewindOutcome {
  action: StateAction;
  persistedAction: StateAction;
  event: RewindEvent;
}

export interface BuildRewindActionOptions {
  request: RewindTarget;
  ref: SessionRef;
  state: WorkflowState;
  persistEvent?: boolean | undefined;
  persistTranscript?: boolean | undefined;
}

export function buildRewindAction({
  request,
  ref,
  state,
  persistEvent = true,
  persistTranscript = true,
}: BuildRewindActionOptions): RewindOutcome {
  if (request.target === 'spec') {
    const rawEvent: RewindEvent = {
      ts: Date.now(),
      type: 'rewind_to_spec',
      phase: state.phase,
      ...(request.comment ? { comment: request.comment } : {}),
    };
    const event = projectRewindEventForTranscriptPolicy(rawEvent, persistTranscript);
    if (persistEvent) appendRewindEvent(ref, event);
    const action: StateAction = {
      type: 'REWIND_TO_SPEC',
      ...(request.comment ? { comment: request.comment } : {}),
    };
    return {
      action,
      persistedAction: projectRewindActionForTranscriptPolicy(action, persistTranscript),
      event,
    };
  }
  if (request.target === 'plan') {
    const rawEvent: RewindEvent = {
      ts: Date.now(),
      type: 'rewind_to_plan',
      phase: state.phase,
      ...(request.comment ? { comment: request.comment } : {}),
    };
    const event = projectRewindEventForTranscriptPolicy(rawEvent, persistTranscript);
    if (persistEvent) appendRewindEvent(ref, event);
    const action: StateAction = {
      type: 'REWIND_TO_PLAN',
      ...(request.comment ? { comment: request.comment } : {}),
    };
    return {
      action,
      persistedAction: projectRewindActionForTranscriptPolicy(action, persistTranscript),
      event,
    };
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
  return {
    action,
    persistedAction: action,
    event,
  };
}

function appendRewindEvent(ref: SessionRef, event: RewindEvent): void {
  appendProtectedEngineEvent(ref, event, RewindEventSchema);
}

function projectRewindEventForTranscriptPolicy(
  event: RewindEvent,
  persistTranscript: boolean,
): RewindEvent {
  if (event.type === 'task_reset') return event;
  if (event.comment === undefined) return event;
  if (persistTranscript) return event;
  return { ...event, comment: TRANSCRIPT_OMITTED_MESSAGE };
}

function projectRewindActionForTranscriptPolicy(
  action: StateAction,
  persistTranscript: boolean,
): StateAction {
  if (persistTranscript) return action;
  switch (action.type) {
    case 'REWIND_TO_SPEC':
      return action.comment === undefined
        ? action
        : { type: 'REWIND_TO_SPEC', comment: TRANSCRIPT_OMITTED_MESSAGE };
    case 'REWIND_TO_PLAN':
      return action.comment === undefined
        ? action
        : { type: 'REWIND_TO_PLAN', comment: TRANSCRIPT_OMITTED_MESSAGE };
    default:
      return action;
  }
}
