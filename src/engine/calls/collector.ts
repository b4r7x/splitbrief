import { error } from '../../utils/error.js';
import { isRunnerCallTerminalEvent } from './status.js';
import { applyRunnerCallUsageSample } from './usage.js';
import type {
  RunnerCallContext,
  RunnerCallError,
  RunnerCallEvent,
  RunnerCallResult,
  RunnerCallStatus,
  RunnerCallUsage,
  RunnerCallWarning,
} from './types.js';

interface RunnerCallCollectionState {
  context: RunnerCallContext | null;
  text: string;
  usage: RunnerCallUsage | null;
  nativeSessionId: string | null;
  toolUses: RunnerCallResult['toolUses'];
  artifacts: RunnerCallResult['artifacts'];
  warnings: RunnerCallWarning[];
  error: RunnerCallError | null;
  terminalStatus: RunnerCallStatus | null;
}

export function collectRunnerCallResult(events: Iterable<RunnerCallEvent>): RunnerCallResult {
  const state: RunnerCallCollectionState = {
    context: null,
    text: '',
    usage: null,
    nativeSessionId: null,
    toolUses: [],
    artifacts: [],
    warnings: [],
    error: null,
    terminalStatus: null,
  };

  for (const event of events) {
    if (state.context === null) {
      state.context = eventContext(event);
    } else {
      assertSameCall(state.context, event);
    }
    if (state.terminalStatus !== null && !isRunnerCallTerminalEvent(event)) {
      state.warnings.push({
        code: 'event_after_terminal',
        message: `Ignored non-terminal event after ${state.terminalStatus} terminal status`,
      });
      continue;
    }
    applyRunnerCallEvent(state, event);
  }

  if (state.context === null) {
    throw error(
      'runner-call-empty',
      'Cannot collect runner call result from an empty event stream',
    );
  }

  const status = state.terminalStatus ?? 'incomplete';
  const missingTerminal =
    state.terminalStatus === null
      ? { code: 'missing_terminal_event', message: 'Runner call ended without a terminal event' }
      : null;

  return {
    callId: state.context.callId,
    role: state.context.role,
    backendKind: state.context.backendKind,
    status,
    text: state.text,
    usage: state.usage,
    nativeSessionId: state.nativeSessionId,
    toolUses: state.toolUses,
    artifacts: state.artifacts,
    warnings: state.warnings,
    error: state.error ?? missingTerminal,
    partial: status !== 'completed',
  };
}

function eventContext(event: RunnerCallEvent): RunnerCallContext {
  return {
    callId: event.callId,
    role: event.role,
    backendKind: event.backendKind,
    ...(event.runnerName !== undefined && { runnerName: event.runnerName }),
    ...(event.model !== undefined && { model: event.model }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
  };
}

function assertSameCall(context: RunnerCallContext, event: RunnerCallEvent): void {
  if (
    context.callId === event.callId &&
    context.role === event.role &&
    context.backendKind === event.backendKind
  ) {
    return;
  }

  throw error(
    'runner-call-mixed-events',
    'Runner call collector received events from another call',
    {
      expectedCallId: context.callId,
      actualCallId: event.callId,
    },
  );
}

function applyRunnerCallEvent(state: RunnerCallCollectionState, event: RunnerCallEvent): void {
  switch (event.type) {
    case 'call_started':
      return;
    case 'call_text_delta':
      state.text += event.text;
      return;
    case 'call_stderr_delta':
      state.warnings.push({ code: 'stderr', message: event.text });
      return;
    case 'call_tool_use_delta':
      return;
    case 'call_tool_use_done':
      state.toolUses.push(event.toolUse);
      return;
    case 'call_usage':
      state.usage = applyRunnerCallUsageSample(state.usage, {
        semantics: event.semantics,
        usage: event.usage,
      });
      return;
    case 'call_session_id':
      state.nativeSessionId = event.nativeSessionId;
      return;
    case 'call_artifact':
      state.artifacts.push(event.artifact);
      return;
    case 'call_warning':
      state.warnings.push(event.warning);
      return;
    case 'call_error':
      state.terminalStatus = event.status;
      state.error = event.error;
      return;
    case 'call_completed':
      state.terminalStatus = event.status;
      if (event.usage !== null) {
        state.usage = applyRunnerCallUsageSample(state.usage, {
          semantics: 'final',
          usage: event.usage,
        });
      }
      state.nativeSessionId = event.nativeSessionId;
      return;
    case 'call_unknown_upstream':
      state.warnings.push({
        code: 'unknown_upstream',
        message: event.rawPreview,
      });
      return;
  }
}
