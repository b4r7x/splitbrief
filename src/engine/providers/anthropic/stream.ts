import type { TokenDelta } from '../../../core/types/summary.js';
import type { InvokeResult } from '../../runners/types.js';
import { formatErrorWithHint } from '../../errors/hints.js';
import { redactSecrets } from '../../../utils/redact.js';
import { IdleTimeoutError, withIdleTimeout } from '../../../utils/with-timeout.js';
import { stripV1Suffix, ANTHROPIC_API_VERSION } from '../../http.js';
import { narrowRecord, assertNever } from '../../../utils/type-guards.js';
import { STREAM_TIMEOUT_MS, throwMappedError } from '../../streaming/stream-errors.js';

type AnthropicEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'ping'
  | 'error';

const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicMessage {
  role: 'assistant' | 'user';
  content: string;
}

interface AnthropicStreamOptions {
  apiKey: string;
  apiBase: string;
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature: number;
  onProgress: (text: string) => void;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

interface SseEvent {
  data: string;
}

function splitSystemMessages(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): { system: string | undefined; conversation: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const conversation: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    conversation.push({ role: message.role, content: message.content });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    conversation,
  };
}

function parseUsage(value: unknown): Partial<TokenDelta> {
  const usage = narrowRecord(value);
  if (usage === null) return {};

  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined;

  return {
    ...(inputTokens !== undefined && { inputTokens }),
    ...(outputTokens !== undefined && { outputTokens }),
  };
}

function mergeUsage(current: TokenDelta | null, next: Partial<TokenDelta>): TokenDelta | null {
  const inputTokens = next.inputTokens ?? current?.inputTokens;
  const outputTokens = next.outputTokens ?? current?.outputTokens;
  if (inputTokens === undefined && outputTokens === undefined) return current;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  };
}

function parseSseEvent(rawEvent: string): SseEvent | null {
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

async function* readSseEvents(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) break;
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseEvent(rawEvent);
        if (parsed) yield parsed;
      }
    }

    buffer += decoder.decode();
    const trailing = parseSseEvent(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

const ANTHROPIC_EVENT_TYPES = [
  'message_start', 'content_block_start', 'content_block_delta',
  'content_block_stop', 'message_delta', 'message_stop', 'ping', 'error',
] as const satisfies readonly AnthropicEventType[];

const ANTHROPIC_EVENT_TYPE_SET: ReadonlySet<string> = new Set(ANTHROPIC_EVENT_TYPES);

function isAnthropicEventType(t: string): t is AnthropicEventType {
  return ANTHROPIC_EVENT_TYPE_SET.has(t);
}

function getEventType(payload: Record<string, unknown>): AnthropicEventType | null {
  const t = payload.type;
  if (typeof t !== 'string') return null;
  return isAnthropicEventType(t) ? t : null;
}

function getMessageUsage(payload: Record<string, unknown>): Partial<TokenDelta> {
  const message = narrowRecord(payload.message);
  return message ? parseUsage(message.usage) : {};
}

function getDeltaText(payload: Record<string, unknown>): string | null {
  const delta = narrowRecord(payload.delta);
  if (delta === null) return null;
  if (delta.type !== 'text_delta') return null;
  return typeof delta.text === 'string' ? delta.text : null;
}

function getApiErrorMessage(payload: Record<string, unknown>): string {
  const error = narrowRecord(payload.error);
  if (error && typeof error.message === 'string') return error.message;
  return JSON.stringify(payload);
}

export async function streamAnthropicCompletion(
  opts: AnthropicStreamOptions,
): Promise<InvokeResult> {
  const { system, conversation } = splitSystemMessages(opts.messages);
  const url = `${stripV1Suffix(opts.apiBase)}/v1/messages`;
  const endpoint = { provider: 'anthropic', apiBase: opts.apiBase };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'anthropic-version': ANTHROPIC_API_VERSION,
        'content-type': 'application/json',
        'x-api-key': opts.apiKey,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: conversation,
        temperature: opts.temperature,
        stream: true,
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(system && { system }),
      }),
      signal: opts.signal ?? null,
    });
  } catch (err: unknown) {
    throwMappedError(err, endpoint);
  }

  if (!response.ok) {
    const message = await response.text();
    const raw = redactSecrets(`API error ${response.status} from anthropic: ${message}`);
    throw new Error(formatErrorWithHint(raw));
  }

  if (!response.body) {
    throw new Error('Anthropic response stream was empty');
  }

  let fullResponse = '';
  let usage: TokenDelta | null = null;

  try {
    for await (const event of withIdleTimeout(
      readSseEvents(response.body, opts.signal),
      STREAM_TIMEOUT_MS,
      'Model response timed out',
    )) {
      if (event.data === '[DONE]') continue;

      const payload = narrowRecord(JSON.parse(event.data));
      if (payload === null) continue;

      const eventType = getEventType(payload);
      if (eventType === null) continue;
      switch (eventType) {
        case 'message_start':
          usage = mergeUsage(usage, getMessageUsage(payload));
          break;
        case 'content_block_delta': {
          const text = getDeltaText(payload);
          if (!text) break;
          fullResponse += text;
          opts.onProgress(text);
          break;
        }
        case 'message_delta':
          usage = mergeUsage(usage, parseUsage(payload.usage));
          break;
        case 'error': {
          const raw = redactSecrets(`API error from anthropic: ${getApiErrorMessage(payload)}`);
          throw new Error(formatErrorWithHint(raw));
        }
        case 'content_block_start':
        case 'content_block_stop':
        case 'message_stop':
        case 'ping':
          break;
        default:
          assertNever(eventType);
      }
    }
  } catch (err: unknown) {
    if (opts.signal?.aborted) {
      return { text: fullResponse, usage };
    }
    if (err instanceof IdleTimeoutError) throw err;
    if (err instanceof SyntaxError) {
      throw new Error(formatErrorWithHint(`Invalid Anthropic stream payload: ${err.message}`));
    }
    throwMappedError(err, endpoint);
  }

  return { text: fullResponse, usage };
}
