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
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../../calls/recorder.js';
import { runnerCallErrorFromUnknown, runnerCallInterruptedStatus } from '../../calls/status.js';
import { normalizeRunnerCallUsage } from '../../calls/usage.js';
import type {
  RunnerCallContext,
  RunnerCallEvent,
  RunnerCallResult,
  RunnerCallUsage,
} from '../../calls/types.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

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
  onCallEvent?: ((event: RunnerCallEvent) => void) | undefined;
  callContext?: RunnerCallContext | undefined;
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

function emitText(recorder: RunnerCallRecorder, text: string): void {
  recorder.text({ channel: 'assistant', text });
}

function emitAnthropicTerminal(
  recorder: RunnerCallRecorder,
  stopReason: string | null,
  sawMessageStop: boolean,
  usage: RunnerCallUsage | null,
): void {
  if (!sawMessageStop) return;

  if (stopReason === 'max_tokens') {
    recorder.finishFailed({
      status: 'truncated',
      error: {
        code: 'anthropic_stop_reason_max_tokens',
        message: 'Anthropic response ended because the max token limit was reached',
      },
      usage,
      nativeSessionId: null,
    });
    return;
  }

  recorder.finishCompleted({ usage, nativeSessionId: null });
}

function mapProviderError(err: unknown, endpoint: { provider: string; apiBase: string }): unknown {
  try {
    throwMappedError(err, endpoint);
  } catch (mapped) {
    return mapped;
  }
}

function finishAnthropicFailure(
  recorder: RunnerCallRecorder,
  err: unknown,
  endpoint: { provider: string; apiBase: string },
  usage: RunnerCallUsage | null,
): never {
  const mapped = mapProviderError(err, endpoint);
  recorder.finishFailed({
    status: 'failed',
    error: runnerCallErrorFromUnknown(mapped, 'anthropic_stream_error'),
    usage,
    nativeSessionId: null,
  });
  throw mapped;
}

export async function streamAnthropicCompletion(
  opts: AnthropicStreamOptions,
): Promise<RunnerCallResult> {
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
  const context = opts.callContext ?? anthropicCallContext(opts.model);
  const recorder = createRunnerCallRecorder({ context, onEvent: opts.onCallEvent });

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
    if (opts.signal?.aborted) {
      recorder.finishFailed({
        status: runnerCallInterruptedStatus(opts.signal),
        error: runnerCallErrorFromUnknown(err, 'runner_interrupted'),
        nativeSessionId: null,
      });
      throwIfAborted(opts.signal);
    }
    finishAnthropicFailure(recorder, err, endpoint, null);
  }

  if (!response.ok) {
    const message = await response.text();
    const err = streamError.httpStatus('anthropic', response.status, message);
    recorder.finishFailed({
      status: 'failed',
      error: runnerCallErrorFromUnknown(err, 'anthropic_http_error'),
      nativeSessionId: null,
    });
    throw err;
  }

  if (!response.body) {
    const err = streamError.emptyResponse('Anthropic');
    recorder.finishFailed({
      status: 'failed',
      error: runnerCallErrorFromUnknown(err, 'anthropic_empty_response'),
      nativeSessionId: null,
    });
    throw err;
  }

  let usage: RunnerCallUsage | null = null;
  let stopReason: string | null = null;
  let sawMessageStop = false;

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
          emitText(recorder, text);
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
      recorder.finishFailed({
        status: runnerCallInterruptedStatus(opts.signal),
        error: { code: 'runner_interrupted', message: toErrorMessage(err) },
        nativeSessionId: null,
      });
      throwIfAborted(opts.signal);
    }
    if (timeoutError.isIdle(err)) {
      recorder.finishFailed({
        status: 'timeout',
        error: { code: 'stream_idle_timeout', message: toErrorMessage(err) },
        nativeSessionId: null,
      });
      throw err;
    }
    if (err instanceof SyntaxError) {
      const mapped = streamError.invalidPayload(
        `Invalid Anthropic stream payload: ${err.message}`,
        err,
      );
      recorder.finishFailed({
        status: 'failed',
        error: runnerCallErrorFromUnknown(mapped, 'anthropic_invalid_payload'),
        usage,
        nativeSessionId: null,
      });
      throw mapped;
    }
    finishAnthropicFailure(recorder, err, endpoint, usage);
  }

  emitAnthropicTerminal(recorder, stopReason, sawMessageStop, usage);
  return recorder.finalResult();
}
