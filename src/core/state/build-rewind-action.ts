import type { StateAction } from './types.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { taskId } from '../schemas/task.js';
import type { TaskId } from '../schemas/task.js';
import type { Phase } from '../schemas/enums.js';
import type { SessionRef } from '../types/session-ref.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../transcript-policy.js';
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
  ref: SessionRef,
  current: WorkflowState,
  opts: { persistEvent?: boolean; persistTranscript?: boolean } = {},
): RewindOutcome {
  const persistEvent = opts.persistEvent ?? true;
  const persistTranscript = opts.persistTranscript ?? true;
  if (request.target === 'spec') {
    const event: RewindEvent = {
      ts: Date.now(),
      type: 'rewind_to_spec',
      phase: current.phase,
      ...(request.comment ? { comment: request.comment } : {}),
    };
    if (persistEvent) appendEngineEvent(ref, projectRewindEvent(event, persistTranscript));
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
    if (persistEvent) appendEngineEvent(ref, projectRewindEvent(event, persistTranscript));
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
  if (persistEvent) appendEngineEvent(ref, event);
  return {
    action: { type: 'RESET_TASK', taskId: tid },
    event,
  };
}

function projectRewindEvent(event: RewindEvent, persistTranscript: boolean): RewindEvent {
  if (persistTranscript || event.type === 'task_reset' || event.comment === undefined) {
    return event;
  }
  return { ...event, comment: TRANSCRIPT_OMITTED_MESSAGE };
}
