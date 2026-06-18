import type {
  RunnerCallContext,
  RunnerCallError,
  RunnerCallEvent,
  RunnerCallFailureStatus,
  RunnerCallUsage,
} from './types.js';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH } from './schema.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { isRecord } from '../../utils/type-guards.js';

export function isRunnerCallTerminalEvent(event: RunnerCallEvent): boolean {
  return event.type === 'call_completed' || event.type === 'call_error';
}

export function boundedRunnerCallMessage(message: string): string {
  if (message.length <= RUNNER_CALL_MESSAGE_MAX_LENGTH) return message;
  return `${message.slice(0, RUNNER_CALL_MESSAGE_MAX_LENGTH - 3)}...`;
}

export function runnerCallInterruptedStatus(
  signal: AbortSignal | undefined,
): RunnerCallFailureStatus {
  if (signal?.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
    return 'timeout';
  }
  return 'aborted';
}

export function runnerCallErrorFromUnknown(err: unknown, fallbackCode: string): RunnerCallError {
  const code =
    isRecord(err) && typeof err.kind === 'string' && err.kind.length > 0 ? err.kind : fallbackCode;
  return { code, message: boundedRunnerCallMessage(toErrorMessage(err)) };
}

export function runnerCallCompletedEvent(
  context: RunnerCallContext,
  opts: {
    startedAt: number;
    endedAt: number;
    usage: RunnerCallUsage | null;
    nativeSessionId: string | null;
  },
): RunnerCallEvent {
  return {
    type: 'call_completed',
    ts: opts.endedAt,
    ...context,
    status: 'completed',
    error: null,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    durationMs: Math.max(0, opts.endedAt - opts.startedAt),
    partial: false,
    usage: opts.usage,
    nativeSessionId: opts.nativeSessionId,
  };
}

export function runnerCallErrorEvent(
  context: RunnerCallContext,
  opts: {
    startedAt: number;
    endedAt: number;
    status: RunnerCallFailureStatus;
    error: RunnerCallError;
    usage: RunnerCallUsage | null;
    nativeSessionId: string | null;
    partial: boolean;
  },
): RunnerCallEvent {
  return {
    type: 'call_error',
    ts: opts.endedAt,
    ...context,
    status: opts.status,
    error: opts.error,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    durationMs: Math.max(0, opts.endedAt - opts.startedAt),
    partial: opts.partial,
    usage: opts.usage,
    nativeSessionId: opts.nativeSessionId,
  };
}
