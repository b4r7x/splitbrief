import { isProcessWentAwayMark } from '../../../../core/phases/of-event.js';
import type { Section } from '../../../../core/sections/types.js';
import {
  PLANNER_SESSION_EXPIRED_CODE,
  PLANNER_SESSION_REFUSED_CODE,
} from '../../../../core/sessions/planner-reissue.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import type { RunnerActivityEvent } from './types.js';

export function retriedImplementerAttempts(
  sections: readonly Section<EngineEvent>[],
): Set<EngineEvent> {
  const hidden = new Set<EngineEvent>();
  let pendingFailure: EngineEventOf<'implementer_generate_failed'> | undefined;
  for (const section of sections) {
    for (const event of section.items) {
      if (event.type === 'implementer_generate_running') {
        pendingFailure = undefined;
      } else if (event.type === 'implementer_generate_failed') {
        pendingFailure = event;
      } else if (event.type === 'seat_retry' && event.seat === 'build') {
        if (pendingFailure !== undefined) {
          hidden.add(pendingFailure);
          pendingFailure = undefined;
        }
      }
    }
  }
  return hidden;
}

/**
 * The error and the warnings of each planner call that the run issued again on a fresh session:
 * an expired thread or one the tool refused as too long. The debug event of the reissue follows the
 * error of the call it reissues, before the next call reports.
 */
export function reissuedPlannerCallDiagnostics(
  sections: readonly Section<EngineEvent>[],
): Set<EngineEvent> {
  const hidden = new Set<EngineEvent>();
  const warnings = new Map<string, RunnerActivityEvent[]>();
  let failed: RunnerActivityEvent | undefined;
  for (const section of sections) {
    for (const event of section.items) {
      if (event.type === 'runner_call_activity') {
        if (event.stage === 'warning')
          warnings.set(event.callId, [...(warnings.get(event.callId) ?? []), event]);
        if (isCallError(event)) failed = event;
        else if (event.callId !== failed?.callId) failed = undefined;
      } else if (
        event.type === 'debug' &&
        (event.code === PLANNER_SESSION_EXPIRED_CODE || event.code === PLANNER_SESSION_REFUSED_CODE)
      ) {
        if (failed !== undefined) {
          hidden.add(failed);
          for (const warning of warnings.get(failed.callId) ?? []) hidden.add(warning);
        }
        failed = undefined;
      }
    }
  }
  return hidden;
}

/**
 * The consult answers that never applied: a rewrite or a split shows its row once its brief is
 * replaced or split. An answer that the criteria guard holds waits for the operator, and an answer
 * a later one on the same brief replaced never applied either.
 */
export function heldConsultAnswers(sections: readonly Section<EngineEvent>[]): Set<EngineEvent> {
  const held = new Set<EngineEvent>();
  const pending = new Map<string, EngineEventOf<'consult_answered'>>();
  for (const section of sections) {
    for (const event of section.items) {
      switch (event.type) {
        case 'consult_answered': {
          const previous = pending.get(event.taskId);
          if (previous !== undefined) held.add(previous);
          const waits =
            (event.reason === 'failed' || event.reason === 'blocked') &&
            (event.action === 'rewrite-task' || event.action === 'split-task');
          if (waits) pending.set(event.taskId, event);
          else pending.delete(event.taskId);
          break;
        }
        case 'task_replaced':
          pending.delete(event.taskId);
          break;
        case 'tasks_inserted':
          pending.delete(event.parentId);
          break;
      }
    }
  }
  for (const answer of pending.values()) held.add(answer);
  return held;
}

/**
 * The `working on <file>…` rows whose attempt has ended. The row says a BUILD call is running; once
 * the attempt is done, failed, reset, cut by a stop, closed by a call error — the interruption a
 * process that went away leaves — or left by a process that went away after its call, the rows
 * after it say what happened, and the row goes.
 */
export function endedImplementerAttempts(
  sections: readonly Section<EngineEvent>[],
): Set<EngineEvent> {
  const ended = new Set<EngineEvent>();
  const open = new Map<string, EngineEventOf<'implementer_generate_running'>>();
  const end = (taskId: string | undefined): void => {
    for (const [openTaskId, running] of open) {
      if (taskId !== undefined && taskId !== openTaskId) continue;
      ended.add(running);
      open.delete(openTaskId);
    }
  };
  for (const section of sections) {
    for (const event of section.items) {
      switch (event.type) {
        case 'implementer_generate_running':
          end(event.taskId);
          open.set(event.taskId, event);
          break;
        case 'implementer_generate_done':
        case 'implementer_generate_failed':
        case 'task_reset':
          end(event.taskId);
          break;
        case 'turn_interrupted':
        case 'workflow_cancelled':
        case 'workflow_resumed':
          end(undefined);
          break;
        case 'replay_complete':
          if (isProcessWentAwayMark(event)) end(undefined);
          break;
        case 'runner_call_activity':
          if (event.role === 'implementer' && isCallError(event)) end(event.taskId);
          break;
      }
    }
  }
  return ended;
}

/**
 * The activity of the calls that have ended. A call ends at its completion or at its error, which
 * the log keeps as the call's terminal activity, and a stop, a cancel or a continue ends every call
 * still in flight.
 */
export function endedCallActivity(sections: readonly Section<EngineEvent>[]): Set<EngineEvent> {
  const ended = new Set<EngineEvent>();
  const open = new Map<string, RunnerActivityEvent[]>();
  const end = (callId: string): void => {
    for (const activity of open.get(callId) ?? []) ended.add(activity);
    open.delete(callId);
  };
  for (const section of sections) {
    for (const event of section.items) {
      switch (event.type) {
        case 'runner_call_activity': {
          const activity = open.get(event.callId);
          if (activity === undefined) open.set(event.callId, [event]);
          else activity.push(event);
          if (isCallError(event)) end(event.callId);
          break;
        }
        case 'runner_call_completed':
          end(event.callId);
          break;
        case 'turn_interrupted':
        case 'workflow_cancelled':
        case 'workflow_resumed':
          for (const callId of [...open.keys()]) end(callId);
          break;
      }
    }
  }
  return ended;
}

/** A call's error is its terminal activity; an error-severity warning leaves the call running. */
function isCallError(activity: RunnerActivityEvent): boolean {
  return activity.kind === 'error' && activity.stage !== 'warning';
}
