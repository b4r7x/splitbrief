import type { InvokeResult } from '../../runners/types.js';
import type { EffortLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import { effortToAnthropicBudget } from '../../../core/schemas/enums.js';
import { anthropicModelSupportsTemperature } from '../capability-inference.js';
import { timeoutError, withIdleTimeout } from '../../../utils/with-timeout.js';
import { stripV1Suffix, ANTHROPIC_API_VERSION, TRUNCATION_WARNING } from '../constants.js';
import { narrowRecord, assertNever } from '../../../utils/type-guards.js';
import { streamError, throwMappedError } from '../../streaming/stream-errors.js';
import { STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MESSAGE } from '../../constants.js';
import { attachImagesToLastUserMessage } from '../image-attach.js';
import { throwIfAborted } from '../../../utils/abort.js';
import type { StreamMessage } from '../dispatch-stream.js';
import { collectRunnerCallResult } from '../../calls/collector.js';
import { toInvokeResult } from '../../calls/projection.js';
import { normalizeRunnerCallUsage } from '../../calls/usage.js';
import type { RunnerCallContext, RunnerCallEvent, RunnerCallUsage } from '../../calls/types.js';

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
// Headroom above the thinking budget so the visible answer is never truncated.
// max_tokens must exceed budget_tokens, or the request 400s.
const EFFORT_OUTPUT_HEADROOM = 4096;

function resolveMaxTokens(requested: number | undefined, effort: EffortLevel | undefined): number {
  const base = requested ?? DEFAULT_MAX_TOKENS;
  if (effort === undefined) return base;
  return Math.max(base, effortToAnthropicBudget(effort) + EFFORT_OUTPUT_HEADROOM);
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

interface AnthropicMessage {
  role: 'assistant' | 'user';
  content: string | AnthropicContentBlock[];
}

interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicStreamOptions {
  apiKey: string;
  apiBase: string;
  model: string;
  messages: StreamMessage[];
  temperature: number;
  onProgress: (text: string) => void;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
}

interface SseEvent {
  data: string;
}

interface SseBoundary {
  index: number;
  length: number;
}

let callSequence = 0;

function anthropicCallContext(model: string): RunnerCallContext {
  return {
    callId: `anthropic-stream-${++callSequence}`,
    role: 'planner',
    backendKind: 'api',
    runnerName: 'anthropic',
    model,
  };
}

function splitSystemMessages(messages: StreamMessage[]): {
  system: AnthropicSystemBlock[] | undefined;
  conversation: AnthropicMessage[];
} {
  const systemBlocks: AnthropicSystemBlock[] = [];
  const conversation: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemBlocks.push({ type: 'text', text: message.content });
      continue;
    }
    conversation.push({ role: message.role, content: message.content });
  }

  if (systemBlocks.length === 0) return { system: undefined, conversation };
  const last = systemBlocks[systemBlocks.length - 1];
  if (last) last.cache_control = { type: 'ephemeral' };
  return { system: systemBlocks, conversation };
}

function hasNumericField(record: Record<string, unknown> | null, field: string): boolean {
  return typeof record?.[field] === 'number';
}

function mergeUsage(current: RunnerCallUsage | null, raw: unknown): RunnerCallUsage | null {
  const next = normalizeRunnerCallUsage(raw);
  if (next === null) return current;

  const record = narrowRecord(raw);
  const hasInput =
    hasNumericField(record, 'input_tokens') || hasNumericField(record, 'inputTokens');
  const hasOutput =
    hasNumericField(record, 'output_tokens') || hasNumericField(record, 'outputTokens');
  const hasCacheRead =
    hasNumericField(record, 'cache_read_input_tokens') ||
    hasNumericField(record, 'cached_input_tokens') ||
    hasNumericField(record, 'cacheReadTokens');
  const hasCacheCreate =
    hasNumericField(record, 'cache_creation_input_tokens') ||
    hasNumericField(record, 'cache_write_input_tokens') ||
    hasNumericField(record, 'cacheCreateTokens') ||
    hasNumericField(record, 'cacheWriteTokens');
  const hasReasoning = hasNumericField(record, 'reasoningTokens');

  const inputTokens = hasInput ? next.inputTokens : current?.inputTokens;
  const outputTokens = hasOutput ? next.outputTokens : current?.outputTokens;
  const cacheReadTokens = hasCacheRead ? next.cacheReadTokens : current?.cacheReadTokens;
  const cacheCreateTokens = hasCacheCreate ? next.cacheCreateTokens : current?.cacheCreateTokens;
  const reasoningTokens = hasReasoning ? next.reasoningTokens : current?.reasoningTokens;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheCreateTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return current;
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheCreateTokens !== undefined && { cacheCreateTokens }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
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

function findSseBoundary(buffer: string): SseBoundary | null {
  const lfIndex = buffer.indexOf('\n\n');
  const crlfIndex = buffer.indexOf('\r\n\r\n');

  if (lfIndex === -1 && crlfIndex === -1) return null;
  if (lfIndex === -1) return { index: crlfIndex, length: 4 };
  if (crlfIndex === -1) return { index: lfIndex, length: 2 };
  return lfIndex < crlfIndex ? { index: lfIndex, length: 2 } : { index: crlfIndex, length: 4 };
}

async function* readSseEvents(
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
        const parsed = parseSseEvent(rawEvent);
        if (parsed) yield parsed;
      }
    }

    buffer += decoder.decode();
    throwIfAborted(signal);
    const trailing = parseSseEvent(buffer);
    if (trailing) yield trailing;
  } finally {
    reader.releaseLock();
  }
}

const ANTHROPIC_EVENT_TYPES = [
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
  'error',
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

function getStopReason(payload: Record<string, unknown>): string | null {
  const delta = narrowRecord(payload.delta);
  if (delta === null) return null;
  return typeof delta.stop_reason === 'string' ? delta.stop_reason : null;
}

function emitText(events: RunnerCallEvent[], context: RunnerCallContext, text: string): void {
  events.push({
    type: 'call_text_delta',
    ts: Date.now(),
    ...context,
    channel: 'assistant',
    text,
  });
}

function emitAnthropicTerminal(
  events: RunnerCallEvent[],
  context: RunnerCallContext,
  stopReason: string | null,
  sawMessageStop: boolean,
  usage: RunnerCallUsage | null,
): void {
  if (!sawMessageStop) return;

  if (stopReason === 'max_tokens') {
    events.push({
      type: 'call_error',
      ts: Date.now(),
      ...context,
      status: 'truncated',
      error: {
        code: 'anthropic_stop_reason_max_tokens',
        message: 'Anthropic response ended because the max token limit was reached',
      },
    });
    return;
  }

  events.push({
    type: 'call_completed',
    ts: Date.now(),
    ...context,
    status: 'completed',
    usage,
    nativeSessionId: null,
  });
}

export async function streamAnthropicCompletion(
  opts: AnthropicStreamOptions,
): Promise<InvokeResult> {
  const { system, conversation } = splitSystemMessages(opts.messages);
  const finalConversation =
    opts.images && opts.images.length > 0
      ? await attachImagesToLastUserMessage<
          AnthropicMessage,
          AnthropicContentBlock,
          AnthropicImageBlock
        >(conversation, {
          images: opts.images,
          imagePlacement: 'before-existing',
          mapText: (text) => ({ type: 'text', text }),
          mapImage: ({ mime, data }) => ({
            type: 'image',
            source: { type: 'base64', media_type: mime, data },
          }),
          createUserMessage: (content) => ({ role: 'user', content }),
        })
      : conversation;
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
        messages: finalConversation,
        ...(opts.effort === undefined &&
          anthropicModelSupportsTemperature(opts.model) && { temperature: opts.temperature }),
        stream: true,
        max_tokens: resolveMaxTokens(opts.maxTokens, opts.effort),
        ...(system && { system }),
        ...(opts.effort !== undefined && {
          thinking: { type: 'enabled', budget_tokens: effortToAnthropicBudget(opts.effort) },
        }),
      }),
      signal: opts.signal ?? null,
    });
  } catch (err: unknown) {
    throwMappedError(err, endpoint);
  }

  if (!response.ok) {
    const message = await response.text();
    throw streamError.httpStatus('anthropic', response.status, message);
  }

  if (!response.body) {
    throw streamError.emptyResponse('Anthropic');
  }

  let usage: RunnerCallUsage | null = null;
  let stopReason: string | null = null;
  let sawMessageStop = false;
  const context = anthropicCallContext(opts.model);
  const events: RunnerCallEvent[] = [{ type: 'call_started', ts: Date.now(), ...context }];

  try {
    for await (const event of withIdleTimeout(
      readSseEvents(response.body, opts.signal),
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_MESSAGE,
    )) {
      if (event.data === '[DONE]') continue;

      const raw: unknown = JSON.parse(event.data);
      const payload = narrowRecord(raw);
      if (payload === null) continue;

      const eventType = getEventType(payload);
      if (eventType === null) continue;
      switch (eventType) {
        case 'message_start':
          usage = mergeUsage(usage, narrowRecord(payload.message)?.usage);
          break;
        case 'content_block_delta': {
          const text = getDeltaText(payload);
          if (!text) break;
          emitText(events, context, text);
          opts.onProgress(text);
          break;
        }
        case 'message_delta': {
          usage = mergeUsage(usage, payload.usage);
          const nextStopReason = getStopReason(payload);
          stopReason = nextStopReason ?? stopReason;
          if (nextStopReason === 'max_tokens') opts.onProgress(TRUNCATION_WARNING);
          break;
        }
        case 'error':
          throw streamError.apiError('anthropic', getApiErrorMessage(payload));
        case 'content_block_start':
        case 'content_block_stop':
        case 'ping':
          break;
        case 'message_stop':
          sawMessageStop = true;
          break;
        default:
          assertNever(eventType);
      }
    }
  } catch (err: unknown) {
    if (opts.signal?.aborted) {
      throwIfAborted(opts.signal);
    }
    if (timeoutError.isIdle(err)) throw err;
    if (err instanceof SyntaxError) {
      throw streamError.invalidPayload(`Invalid Anthropic stream payload: ${err.message}`, err);
    }
    throwMappedError(err, endpoint);
  }

  emitAnthropicTerminal(events, context, stopReason, sawMessageStop, usage);
  return toInvokeResult(collectRunnerCallResult(events));
}
