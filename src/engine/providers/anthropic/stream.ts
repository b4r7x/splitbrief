import { z } from 'zod';
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
import type { StreamMessage } from '../stream-types.js';
import { createRunnerCallRecorder, type RunnerCallRecorder } from '../../calls/recorder.js';
import { runnerCallErrorFromUnknown, runnerCallInterruptedStatus } from '../../calls/status.js';
import { normalizeRunnerCallUsage } from '../../calls/usage.js';
import { runnerCallUnknownUpstreamPreview } from '../../calls/unknown-upstream.js';
import {
  createRunnerCallDeltaLimiter,
  finishRunnerCallOutputLimit,
  runnerCallOutputLimitError,
  runnerCallOutputLimitFromError,
  takeUtf8PrefixBytes,
  RUNNER_CALL_HTTP_ERROR_BODY_MAX_BYTES,
  RUNNER_CALL_SSE_EVENT_MAX_BYTES,
  type RunnerCallDeltaLimitResult,
  type RunnerCallOutputLimit,
} from '../../calls/output-limit.js';
import type {
  RunnerCallContext,
  RunnerCallEvent,
  RunnerCallResult,
  RunnerCallUsage,
} from '../../calls/types.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

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

interface BoundedResponseText {
  text: string;
  bytesSeen: number;
  truncated: boolean;
}

const AnthropicMessageStartPayloadSchema = z.looseObject({
  type: z.literal('message_start'),
  message: z.looseObject({ usage: z.unknown().optional() }).optional(),
});

const AnthropicContentBlockDeltaPayloadSchema = z.looseObject({
  type: z.literal('content_block_delta'),
  delta: z.looseObject({
    type: z.string().optional(),
    text: z.string().optional(),
  }),
});

const AnthropicMessageDeltaPayloadSchema = z.looseObject({
  type: z.literal('message_delta'),
  delta: z
    .looseObject({
      stop_reason: z.string().nullable().optional(),
    })
    .optional(),
  usage: z.unknown().optional(),
});

const AnthropicErrorPayloadSchema = z.looseObject({
  type: z.literal('error'),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

const AnthropicPayloadSchema = z.discriminatedUnion('type', [
  AnthropicMessageStartPayloadSchema,
  z.looseObject({ type: z.literal('content_block_start') }),
  AnthropicContentBlockDeltaPayloadSchema,
  z.looseObject({ type: z.literal('content_block_stop') }),
  AnthropicMessageDeltaPayloadSchema,
  z.looseObject({ type: z.literal('message_stop') }),
  z.looseObject({ type: z.literal('ping') }),
  AnthropicErrorPayloadSchema,
]);

type AnthropicPayload = z.infer<typeof AnthropicPayloadSchema>;

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

async function readResponseTextBounded(response: Response): Promise<BoundedResponseText> {
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

function formatBoundedErrorBody(body: BoundedResponseText): string {
  if (!body.truncated) return body.text;
  return `${body.text}\n[response body truncated at ${RUNNER_CALL_HTTP_ERROR_BODY_MAX_BYTES} bytes]`;
}

function getDeltaText(
  payload: Extract<AnthropicPayload, { type: 'content_block_delta' }>,
): string | null {
  const delta = payload.delta;
  if (delta.type !== 'text_delta') return null;
  return typeof delta.text === 'string' ? delta.text : null;
}

function getApiErrorMessage(payload: Extract<AnthropicPayload, { type: 'error' }>): string {
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
  return JSON.stringify(payload);
}

function getStopReason(
  payload: Extract<AnthropicPayload, { type: 'message_delta' }>,
): string | null {
  return payload.delta?.stop_reason ?? null;
}

function emitText(
  recorder: RunnerCallRecorder,
  text: string,
  limiter: ReturnType<typeof createRunnerCallDeltaLimiter>,
): RunnerCallDeltaLimitResult {
  const accepted = limiter.accept(text);
  if (accepted.text.length > 0) recorder.text({ channel: 'assistant', text: accepted.text });
  return accepted;
}

function emitUsageUpdate(
  recorder: RunnerCallRecorder,
  current: RunnerCallUsage | null,
  raw: unknown,
): RunnerCallUsage | null {
  const next = mergeUsage(current, raw);
  if (next !== current && next !== null) {
    recorder.usage({ usage: next, semantics: 'cumulative' });
  }
  return next;
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

function parseAnthropicPayload(
  raw: unknown,
  recorder: RunnerCallRecorder,
): AnthropicPayload | null {
  const parsed = AnthropicPayloadSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  recorder.unknownUpstream({
    rawPreview: runnerCallUnknownUpstreamPreview({
      label: 'Invalid Anthropic stream payload',
      value: raw,
      issues: parsed.error.issues,
    }),
    backendMetadata: {
      backendKind: recorder.context.backendKind,
      source: 'anthropic-stream',
      parser: 'sse_event',
      ...(upstreamType(raw) !== undefined && { upstreamType: upstreamType(raw) }),
    },
  });
  return null;
}

function parseAnthropicEventData(data: string, recorder: RunnerCallRecorder): unknown {
  try {
    return JSON.parse(data);
  } catch (err) {
    recorder.unknownUpstream({
      rawPreview: runnerCallUnknownUpstreamPreview({
        label: 'Malformed Anthropic stream payload',
        value: data,
      }),
      backendMetadata: {
        backendKind: recorder.context.backendKind,
        source: 'anthropic-stream',
        parser: 'sse_event',
        upstreamType: 'malformed_json',
      },
    });
    throw err;
  }
}

function upstreamType(raw: unknown): string | undefined {
  const record = narrowRecord(raw);
  return typeof record?.type === 'string' ? record.type : undefined;
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
    const message = formatBoundedErrorBody(await readResponseTextBounded(response));
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
  const textLimiter = createRunnerCallDeltaLimiter({
    code: 'provider_text_delta_limit',
    label: 'provider text deltas',
  });
  let outputLimit: RunnerCallDeltaLimitResult['limit'] = null;

  try {
    for await (const event of withIdleTimeout(
      readSseEvents(response.body, opts.signal),
      STREAM_IDLE_TIMEOUT_MS,
      STREAM_IDLE_TIMEOUT_MESSAGE,
    )) {
      if (event.data === '[DONE]') continue;

      const raw = parseAnthropicEventData(event.data, recorder);
      const payload = parseAnthropicPayload(raw, recorder);
      if (payload === null) continue;
      const eventType = payload.type;
      switch (eventType) {
        case 'message_start':
          usage = emitUsageUpdate(recorder, usage, payload.message?.usage);
          break;
        case 'content_block_delta': {
          const text = getDeltaText(payload);
          if (!text) break;
          const accepted = emitText(recorder, text, textLimiter);
          if (accepted.text.length > 0) opts.onProgress(accepted.text);
          if (accepted.limit !== null) {
            outputLimit = accepted.limit;
            break;
          }
          break;
        }
        case 'message_delta': {
          usage = emitUsageUpdate(recorder, usage, payload.usage);
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
      if (outputLimit !== null) break;
    }
  } catch (err: unknown) {
    if (opts.signal?.aborted) {
      recorder.finishFailed({
        status: runnerCallInterruptedStatus(opts.signal),
        error: { code: 'runner_interrupted', message: toErrorMessage(err) },
        usage,
        nativeSessionId: null,
      });
      throwIfAborted(opts.signal);
    }
    if (timeoutError.isIdle(err)) {
      recorder.finishFailed({
        status: 'timeout',
        error: { code: 'stream_idle_timeout', message: toErrorMessage(err) },
        usage,
        nativeSessionId: null,
      });
      throw err;
    }
    const outputLimit = runnerCallOutputLimitFromError(err);
    if (outputLimit !== null) {
      finishRunnerCallOutputLimit(recorder, outputLimit, { usage, nativeSessionId: null });
      return recorder.finalResult();
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

  if (outputLimit !== null) {
    finishRunnerCallOutputLimit(recorder, outputLimit, { usage, nativeSessionId: null });
    return recorder.finalResult();
  }

  emitAnthropicTerminal(recorder, stopReason, sawMessageStop, usage);
  return recorder.finalResult();
}
