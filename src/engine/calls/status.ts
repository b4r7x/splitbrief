import type {
  RunnerCallContext,
  RunnerCallError,
  RunnerCallEvent,
  RunnerCallFailureStatus,
  RunnerCallUsage,
} from './types.js';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH } from './schema.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { escapeRegExp } from '../../utils/regexp.js';
import { isRecord } from '../../utils/type-guards.js';

const RUNNER_CALL_CREDENTIAL_REDACTION_MARKER = '***REDACTED***';

/**
 * A credential shorter than this can also be an ordinary word ("max", "pro",
 * "oauth"), so it is matched only between non-word characters — the same rule
 * `sanitizeProviderDiagnostic` applies to short provider credentials. Longer
 * values are opaque enough to replace wherever they appear.
 */
const CREDENTIAL_WORD_BOUNDARY_MAX_LENGTH = 12;

export type RunnerCallCredentialRedactor = (value: string) => string;

function credentialPattern(credential: string): RegExp {
  const escaped = escapeRegExp(credential);
  return credential.length < CREDENTIAL_WORD_BOUNDARY_MAX_LENGTH
    ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'g')
    : new RegExp(escaped, 'g');
}

export function createRunnerCallCredentialRedactor(
  credentialValues: readonly string[],
): RunnerCallCredentialRedactor {
  const patterns = [
    ...new Set(
      credentialValues.filter(
        (value) => value.length > 0 && value !== RUNNER_CALL_CREDENTIAL_REDACTION_MARKER,
      ),
    ),
  ]
    .sort((left, right) => right.length - left.length)
    .map(credentialPattern);

  return (value) => {
    let redacted = value;
    for (const pattern of patterns) {
      redacted = redacted.replace(pattern, RUNNER_CALL_CREDENTIAL_REDACTION_MARKER);
    }
    return redacted;
  };
}

export function isRunnerCallTerminalEvent(event: RunnerCallEvent): boolean {
  return event.type === 'call_completed' || event.type === 'call_error';
}

export function boundedRunnerCallMessage(
  message: string,
  credentialValues: readonly string[] = [],
): string {
  const redacted = createRunnerCallCredentialRedactor(credentialValues)(message);
  if (redacted.length <= RUNNER_CALL_MESSAGE_MAX_LENGTH) return redacted;
  return `${redacted.slice(0, RUNNER_CALL_MESSAGE_MAX_LENGTH - 3)}...`;
}

export function runnerCallInterruptedStatus(
  signal: AbortSignal | undefined,
): RunnerCallFailureStatus {
  if (signal?.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
    return 'timeout';
  }
  return 'aborted';
}

export function runnerCallErrorFromUnknown(
  err: unknown,
  fallbackCode: string,
  credentialValues: readonly string[] = [],
): RunnerCallError {
  const code =
    isRecord(err) && typeof err.kind === 'string' && err.kind.length > 0 ? err.kind : fallbackCode;
  return { code, message: boundedRunnerCallMessage(toErrorMessage(err), credentialValues) };
}

// The one place that owns the code+message contract for idle-killed calls;
// every backend that catches a 'command-idle-timeout' error reports through it.
export function runnerCallIdleTimeoutError(
  err: unknown,
  credentialValues: readonly string[] = [],
): RunnerCallError {
  return {
    code: 'runner_idle_timeout',
    message: boundedRunnerCallMessage(toErrorMessage(err), credentialValues),
  };
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
