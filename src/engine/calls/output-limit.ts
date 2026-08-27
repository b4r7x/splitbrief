import { error, matches } from '../../utils/error.js';
import { sanitizeTerminalDiagnosticText } from '../../utils/display-text.js';
import { isRecord } from '../../utils/type-guards.js';
import { protectConsumerPayload } from '../../core/consumer-policy.js';
import type {
  TaskCompilationCallEnvelope,
  TaskCompilationFailureCode,
} from '../../core/schemas/task-compilation.js';
import type { RunnerCallRecorder } from './recorder.js';
import { UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH } from './schema.js';
import type {
  RunnerCallEvent,
  RunnerCallResult,
  RunnerCallUsage,
  RunnerCallWarningInput,
} from './types.js';

export const RUNNER_CALL_OUTPUT_MAX_BYTES = 1024 * 1024;
export const RUNNER_CALL_OUTPUT_MAX_EVENTS = 4096;
export const RUNNER_CALL_STDERR_MAX_BYTES = 64 * 1024;
export const RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES = 256 * 1024;
export const RUNNER_CALL_ARTIFACT_TEXT_MAX_BYTES = 256 * 1024;
export const RUNNER_CALL_TOOL_USE_MAX_ITEMS = 256;
export const RUNNER_CALL_ARTIFACT_MAX_ITEMS = 64;
export const RUNNER_CALL_WARNING_MAX_ITEMS = 256;
export const RUNNER_CALL_UNKNOWN_UPSTREAM_MAX_ITEMS = 128;
export const RUNNER_CALL_HTTP_ERROR_BODY_MAX_BYTES = 256 * 1024;
export const RUNNER_CALL_SSE_EVENT_MAX_BYTES = 1024 * 1024;
export const RUNNER_CALL_PAYLOAD_TRUNCATED_KEY = '_truncated';

const ENVELOPE_OUTPUT_LIMITED_CODE: TaskCompilationFailureCode = 'task_compiler_output_limited';
const ENVELOPE_TIMEOUT_CODE: TaskCompilationFailureCode = 'task_compiler_timeout';

export interface RunnerCallOutputLimit {
  code: string;
  message: string;
  bytesSeen?: number | undefined;
  maxBytes?: number | undefined;
  eventsSeen?: number | undefined;
  maxEvents?: number | undefined;
}

export interface RunnerCallDeltaLimitResult {
  text: string;
  limit: RunnerCallOutputLimit | null;
}

type RunnerCallToolUse = Extract<RunnerCallEvent, { type: 'call_tool_use_done' }>['toolUse'];
type RunnerCallArtifact = Extract<RunnerCallEvent, { type: 'call_artifact' }>['artifact'];

export interface RunnerCallBoundedValue<T> {
  value: T;
  limit: RunnerCallOutputLimit | null;
}

export function createRunnerCallDeltaLimiter(opts: {
  code: string;
  label: string;
  maxBytes?: number | undefined;
  maxEvents?: number | undefined;
}): {
  accept: (
    text: string,
    acceptOpts?: { countEvent?: boolean | undefined },
  ) => RunnerCallDeltaLimitResult;
  readonly limit: RunnerCallOutputLimit | null;
} {
  const maxBytes = normalizeLimit(opts.maxBytes ?? RUNNER_CALL_OUTPUT_MAX_BYTES);
  const maxEvents = normalizeLimit(opts.maxEvents ?? RUNNER_CALL_OUTPUT_MAX_EVENTS);
  let bytesStored = 0;
  let eventsStored = 0;
  let limit: RunnerCallOutputLimit | null = null;

  function setLimit(next: RunnerCallOutputLimit): RunnerCallOutputLimit {
    if (limit === null) limit = next;
    return limit;
  }

  return {
    accept(text, acceptOpts = {}) {
      if (limit !== null) return { text: '', limit };

      const shouldCountEvent = acceptOpts.countEvent ?? text.length > 0;
      if (shouldCountEvent && eventsStored >= maxEvents) {
        return {
          text: '',
          limit: setLimit({
            code: opts.code,
            message: `${opts.label} exceeded ${maxEvents} events and was truncated`,
            eventsSeen: eventsStored + 1,
            maxEvents,
          }),
        };
      }

      const textBytes = Buffer.byteLength(text, 'utf8');
      if (bytesStored + textBytes > maxBytes) {
        const remainingBytes = Math.max(0, maxBytes - bytesStored);
        const prefix = takeUtf8PrefixBytes(text, remainingBytes);
        bytesStored += Buffer.byteLength(prefix, 'utf8');
        if (shouldCountEvent && prefix.length > 0) eventsStored += 1;
        return {
          text: prefix,
          limit: setLimit({
            code: opts.code,
            message: `${opts.label} exceeded ${maxBytes} bytes and was truncated`,
            bytesSeen: bytesStored + textBytes - Buffer.byteLength(prefix, 'utf8'),
            maxBytes,
          }),
        };
      }

      bytesStored += textBytes;
      if (shouldCountEvent) eventsStored += 1;
      return { text, limit: null };
    },
    get limit() {
      return limit;
    },
  };
}

export interface RunnerCallEnvelopeLimiter {
  recordRaw: (bytes: number) => void;
  recordNormalized: (deltaBytes: number) => void;
  recordStderr: (bytes: number) => void;
  checkDeadline: (now: number) => void;
  checkIdle: (silentMs: number) => void;
  readonly limit: RunnerCallOutputLimit | null;
}

/**
 * Cumulative counters for one canonical call envelope. Counters never reset;
 * the first breach latches permanently and every later record returns it, so a
 * shorter final response can never clear an overflow. `recordNormalized`
 * accepts a signed delta: a `final` restatement replaces the draft bytes it
 * restates instead of double-counting them. The counter is zero-clamped, so
 * negative deltas can never drive it below zero.
 */
export function createRunnerCallEnvelopeLimiter(opts: {
  envelope: TaskCompilationCallEnvelope;
  startedAt: number;
}): RunnerCallEnvelopeLimiter {
  let limit: RunnerCallOutputLimit | null = null;
  let rawBytes = 0;
  let normalizedBytes = 0;
  let stderrBytes = 0;

  function latch(next: RunnerCallOutputLimit): void {
    if (limit === null) limit = next;
  }

  return {
    recordRaw(bytes) {
      if (limit !== null) return;
      rawBytes += bytes;
      if (rawBytes > opts.envelope.maxRawProtocolBytes) {
        latch({
          code: ENVELOPE_OUTPUT_LIMITED_CODE,
          message: `runner call raw protocol exceeded ${opts.envelope.maxRawProtocolBytes} bytes`,
          bytesSeen: rawBytes,
          maxBytes: opts.envelope.maxRawProtocolBytes,
        });
      }
    },
    recordNormalized(deltaBytes) {
      if (limit !== null) return;
      normalizedBytes = Math.max(0, normalizedBytes + deltaBytes);
      if (normalizedBytes > opts.envelope.maxNormalizedOutputBytes) {
        latch({
          code: ENVELOPE_OUTPUT_LIMITED_CODE,
          message: `runner call normalized output exceeded ${opts.envelope.maxNormalizedOutputBytes} bytes`,
          bytesSeen: normalizedBytes,
          maxBytes: opts.envelope.maxNormalizedOutputBytes,
        });
      }
    },
    recordStderr(bytes) {
      if (limit !== null) return;
      stderrBytes += bytes;
      if (stderrBytes > opts.envelope.maxStderrBytes) {
        latch({
          code: ENVELOPE_OUTPUT_LIMITED_CODE,
          message: `runner call stderr exceeded ${opts.envelope.maxStderrBytes} bytes`,
          bytesSeen: stderrBytes,
          maxBytes: opts.envelope.maxStderrBytes,
        });
      }
    },
    checkDeadline(now) {
      if (limit !== null) return;
      const elapsedMs = Math.max(0, now - opts.startedAt);
      if (elapsedMs > opts.envelope.deadlineMs) {
        latch({
          code: ENVELOPE_TIMEOUT_CODE,
          message: `runner call exceeded ${opts.envelope.deadlineMs} ms deadline`,
        });
      }
    },
    checkIdle(silentMs) {
      if (limit !== null) return;
      if (silentMs > opts.envelope.idleTimeoutMs) {
        latch({
          code: ENVELOPE_TIMEOUT_CODE,
          message: `runner call idle exceeded ${opts.envelope.idleTimeoutMs} ms`,
        });
      }
    },
    get limit() {
      return limit;
    },
  };
}

export function runnerCallLineOutputLimit(opts: {
  code: string;
  label: string;
  lineBytes: number;
  maxLineBytes: number;
}): RunnerCallOutputLimit {
  return {
    code: opts.code,
    message: `${opts.label} exceeded ${opts.maxLineBytes} bytes on one line and was truncated`,
    bytesSeen: opts.lineBytes,
    maxBytes: opts.maxLineBytes,
  };
}

export function runnerCallLimitWarning(limit: RunnerCallOutputLimit): RunnerCallWarningInput {
  return {
    code: limit.code,
    severity: 'warning',
    source: 'system',
    surface: 'activity',
    message: limit.message,
  };
}

export function sanitizeRunnerCallRawPreview(rawPreview: string): string {
  return sanitizeTerminalDiagnosticText(rawPreview, {
    maxChars: UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH,
  });
}

export function boundRunnerCallToolUse(
  toolUse: RunnerCallToolUse,
): RunnerCallBoundedValue<RunnerCallToolUse> {
  const input = boundRunnerCallRecordPayload(
    toolUse.input,
    RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES,
    'tool input payload',
    'runner_call_tool_input_limit',
  );
  const output =
    toolUse.output === undefined
      ? null
      : boundRunnerCallPayload(
          toolUse.output,
          RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES,
          'tool output payload',
          'runner_call_tool_output_limit',
        );
  return {
    value: {
      ...toolUse,
      input: input.value,
      ...(output !== null && { output: output.value }),
    },
    limit: input.limit ?? output?.limit ?? null,
  };
}

export function boundRunnerCallArtifact(
  artifact: RunnerCallArtifact,
): RunnerCallBoundedValue<RunnerCallArtifact> {
  if (artifact.text === null) return { value: artifact, limit: null };
  const bounded = boundRunnerCallStringPayload(
    artifact.text,
    RUNNER_CALL_ARTIFACT_TEXT_MAX_BYTES,
    'artifact text',
    'runner_call_artifact_text_limit',
  );
  return {
    value: { ...artifact, text: bounded.value },
    limit: bounded.limit,
  };
}

export function runnerCallOutputLimitError(limit: RunnerCallOutputLimit): Error {
  return error('runner-output-limit', limit.message, limit);
}

export const isRunnerCallOutputLimitError = matches('runner-output-limit');

export function runnerCallOutputLimitFromError(err: unknown): RunnerCallOutputLimit | null {
  if (!isRunnerCallOutputLimitError(err)) return null;
  const data = err.data;
  if (!isRecord(data) || typeof data.code !== 'string' || typeof data.message !== 'string') {
    return null;
  }
  return {
    code: data.code,
    message: data.message,
    ...(typeof data.bytesSeen === 'number' && { bytesSeen: data.bytesSeen }),
    ...(typeof data.maxBytes === 'number' && { maxBytes: data.maxBytes }),
    ...(typeof data.eventsSeen === 'number' && { eventsSeen: data.eventsSeen }),
    ...(typeof data.maxEvents === 'number' && { maxEvents: data.maxEvents }),
  };
}

export function finishRunnerCallOutputLimit(
  recorder: RunnerCallRecorder,
  limit: RunnerCallOutputLimit,
  opts: {
    usage?: RunnerCallUsage | null | undefined;
    nativeSessionId?: string | null | undefined;
  } = {},
): RunnerCallResult {
  recorder.warning({ warning: runnerCallLimitWarning(limit) });
  return recorder.finishFailed({
    status: 'truncated',
    error: {
      code: limit.code,
      message: limit.message,
    },
    usage: opts.usage,
    nativeSessionId: opts.nativeSessionId,
    partial: true,
  });
}

export function takeUtf8PrefixBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';

  let bytes = 0;
  let result = '';
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

function normalizeLimit(value: number): number {
  return Math.max(0, Math.floor(value));
}

function boundRunnerCallRecordPayload(
  value: Record<string, unknown>,
  maxBytes: number,
  label: string,
  code: string,
): RunnerCallBoundedValue<Record<string, unknown>> {
  const bounded = boundRunnerCallPayload(value, maxBytes, label, code);
  if (isRecord(bounded.value)) {
    return { value: bounded.value, limit: bounded.limit };
  }
  return {
    value: { [RUNNER_CALL_PAYLOAD_TRUNCATED_KEY]: bounded.value },
    limit: bounded.limit,
  };
}

function boundRunnerCallStringPayload(
  value: string,
  maxBytes: number,
  label: string,
  code: string,
): RunnerCallBoundedValue<string> {
  const bounded = protectConsumerPayload({
    context: 'session-log',
    payload: value,
    overrides: { maxBytes, maxStringBytes: maxBytes },
  });
  return {
    value: typeof bounded.payload === 'string' ? bounded.payload : String(bounded.payload),
    limit:
      bounded.truncated || bounded.oversized
        ? {
            code,
            message: `${label} exceeded ${maxBytes} bytes and was truncated`,
            bytesSeen: bounded.bytes,
            maxBytes,
          }
        : null,
  };
}

function boundRunnerCallPayload(
  value: unknown,
  maxBytes: number,
  label: string,
  code: string,
): RunnerCallBoundedValue<unknown> {
  const bounded = protectConsumerPayload({
    context: 'session-log',
    payload: value,
    overrides: { maxBytes, maxStringBytes: maxBytes },
  });
  return {
    value: bounded.payload,
    limit:
      bounded.truncated || bounded.oversized
        ? {
            code,
            message: `${label} exceeded ${maxBytes} bytes and was truncated`,
            bytesSeen: bounded.bytes,
            maxBytes,
          }
        : null,
  };
}
