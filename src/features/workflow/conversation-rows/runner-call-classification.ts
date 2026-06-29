import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';

type RunnerCallEvent = EngineEventOf<
  | 'runner_call_started'
  | 'runner_call_text_delta'
  | 'runner_call_usage'
  | 'runner_call_tool_use'
  | 'runner_call_activity'
  | 'runner_call_session_id'
  | 'runner_call_artifact'
  | 'runner_call_warning'
  | 'runner_call_error'
  | 'runner_call_completed'
>;

type RunnerCallTranscriptSuppressedEvent = Exclude<
  RunnerCallEvent,
  EngineEventOf<'runner_call_activity'>
>;

export function isRunnerCallEvent(event: EngineEvent): event is RunnerCallEvent {
  switch (event.type) {
    case 'runner_call_started':
    case 'runner_call_text_delta':
    case 'runner_call_usage':
    case 'runner_call_tool_use':
    case 'runner_call_activity':
    case 'runner_call_session_id':
    case 'runner_call_artifact':
    case 'runner_call_warning':
    case 'runner_call_error':
    case 'runner_call_completed':
      return true;
    default:
      return false;
  }
}

export function runnerCallId(event: EngineEvent): string | null {
  return isRunnerCallEvent(event) ? event.callId : null;
}

export function isRunnerCallTranscriptRowSuppressed(
  event: EngineEvent,
): event is RunnerCallTranscriptSuppressedEvent {
  return isRunnerCallEvent(event) && event.type !== 'runner_call_activity';
}
