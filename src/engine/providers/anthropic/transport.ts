import { throwIfAborted } from '../../../utils/abort.js';
import {
  runnerCallOutputLimitError,
  takeUtf8PrefixBytes,
  RUNNER_CALL_HTTP_ERROR_BODY_MAX_BYTES,
  RUNNER_CALL_SSE_EVENT_MAX_BYTES,
  type RunnerCallOutputLimit,
} from '../../calls/output-limit.js';

export interface SseEvent {
  data: string;
}

interface SseBoundary {
  index: number;
  length: number;
}

export interface BoundedResponseText {
  text: string;
  bytesSeen: number;
  truncated: boolean;
}

function sseEventLimit(bytesSeen: number): RunnerCallOutputLimit {
  return {
    code: 'provider_sse_event_limit',
    message: `provider SSE event exceeded ${RUNNER_CALL_SSE_EVENT_MAX_BYTES} bytes and was truncated`,
    bytesSeen,
    maxBytes: RUNNER_CALL_SSE_EVENT_MAX_BYTES,
  };
}

function assertSseEventWithinLimit(rawEvent: string): void {
  const bytesSeen = Buffer.byteLength(rawEvent, 'utf8');
  if (bytesSeen <= RUNNER_CALL_SSE_EVENT_MAX_BYTES) return;
  throw runnerCallOutputLimitError(sseEventLimit(bytesSeen));
}

export function parseSseEvent(rawEvent: string): SseEvent | null {
  const normalized = rawEvent.replace(/\r/g, '');
  const dataLines: string[] = [];

  for (const line of normalized.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  return { data: dataLines.join('\n') };
}

function findSseBoundary(buffer: string): SseBoundary | null {
  const lfIndex = buffer.indexOf('\n\n');
  const crlfIndex = buffer.indexOf('\r\n\r\n');

  if (lfIndex === -1 && crlfIndex === -1) return null;
  if (lfIndex === -1) return { index: crlfIndex, length: 4 };
  if (crlfIndex === -1) return { index: lfIndex, length: 2 };
  return lfIndex < crlfIndex ? { index: lfIndex, length: 2 } : { index: crlfIndex, length: 4 };
}

export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = findSseBoundary(buffer);
        if (boundary === null) break;
        const rawEvent = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        throwIfAborted(signal);
        assertSseEventWithinLimit(rawEvent);
        const parsed = parseSseEvent(rawEvent);
        if (parsed) yield parsed;
      }
      assertSseEventWithinLimit(buffer);
    }

    buffer += decoder.decode();
    throwIfAborted(signal);
    assertSseEventWithinLimit(buffer);
    const trailing = parseSseEvent(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

export async function readResponseTextBounded(response: Response): Promise<BoundedResponseText> {
  if (!response.body) return { text: '', bytesSeen: 0, truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytesSeen = 0;
  let truncated = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      bytesSeen += chunkBytes;
      if (!truncated) {
        const remainingBytes =
          RUNNER_CALL_HTTP_ERROR_BODY_MAX_BYTES - Buffer.byteLength(text, 'utf8');
        if (chunkBytes <= remainingBytes) {
          text += chunk;
        } else {
          text += takeUtf8PrefixBytes(chunk, remainingBytes);
          truncated = true;
          await reader.cancel();
          break;
        }
      }
    }
    if (!truncated) {
      const rest = decoder.decode();
      bytesSeen += Buffer.byteLength(rest, 'utf8');
      text += takeUtf8PrefixBytes(
        rest,
        RUNNER_CALL_HTTP_ERROR_BODY_MAX_BYTES - Buffer.byteLength(text, 'utf8'),
      );
      truncated = bytesSeen > Buffer.byteLength(text, 'utf8');
    }
  } finally {
    reader.releaseLock();
  }

  return { text, bytesSeen, truncated };
}

export function formatBoundedErrorBody(body: BoundedResponseText): string {
  if (!body.truncated) return body.text;
  return `${body.text}\n[response body truncated at ${RUNNER_CALL_HTTP_ERROR_BODY_MAX_BYTES} bytes]`;
}
