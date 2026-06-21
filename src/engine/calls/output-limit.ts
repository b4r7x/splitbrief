import { error, matches } from '../../utils/error.js';
import { isRecord } from '../../utils/type-guards.js';
import type { RunnerCallRecorder } from './recorder.js';
import type { RunnerCallResult, RunnerCallUsage } from './types.js';

export const RUNNER_CALL_OUTPUT_MAX_BYTES = 1024 * 1024;
export const RUNNER_CALL_OUTPUT_MAX_EVENTS = 4096;
export const RUNNER_CALL_HTTP_ERROR_BODY_MAX_BYTES = 256 * 1024;
export const RUNNER_CALL_SSE_EVENT_MAX_BYTES = 1024 * 1024;

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
  recorder.warning({
    warning: {
      code: limit.code,
      severity: 'warning',
      source: 'system',
      surface: 'activity',
      message: limit.message,
    },
  });
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
