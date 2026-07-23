import { z } from 'zod';
import { narrowRecord } from '../../../utils/type-guards.js';
import { normalizeRunnerCallUsage } from '../../calls/usage.js';
import type { RunnerCallUsage } from '../../calls/types.js';
import type { RunnerCallRecorder } from '../../calls/recorder.js';
import { runnerCallUnknownUpstreamPreview } from '../../calls/unknown-upstream.js';

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

export const AnthropicPayloadSchema = z.discriminatedUnion('type', [
  AnthropicMessageStartPayloadSchema,
  z.looseObject({ type: z.literal('content_block_start') }),
  AnthropicContentBlockDeltaPayloadSchema,
  z.looseObject({ type: z.literal('content_block_stop') }),
  AnthropicMessageDeltaPayloadSchema,
  z.looseObject({ type: z.literal('message_stop') }),
  z.looseObject({ type: z.literal('ping') }),
  AnthropicErrorPayloadSchema,
]);

export type AnthropicPayload = z.infer<typeof AnthropicPayloadSchema>;

function hasNumericField(record: Record<string, unknown> | null, field: string): boolean {
  return typeof record?.[field] === 'number';
}

function upstreamType(raw: unknown): string | undefined {
  const record = narrowRecord(raw);
  return typeof record?.type === 'string' ? record.type : undefined;
}

export function mergeUsage(current: RunnerCallUsage | null, raw: unknown): RunnerCallUsage | null {
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

export function parseAnthropicPayload(
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

export function parseAnthropicEventData(data: string, recorder: RunnerCallRecorder): unknown {
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

export function getDeltaText(
  payload: Extract<AnthropicPayload, { type: 'content_block_delta' }>,
): string | null {
  const delta = payload.delta;
  if (delta.type !== 'text_delta') return null;
  return typeof delta.text === 'string' ? delta.text : null;
}

export function getApiErrorMessage(payload: Extract<AnthropicPayload, { type: 'error' }>): string {
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
  return JSON.stringify(payload);
}

export function getStopReason(
  payload: Extract<AnthropicPayload, { type: 'message_delta' }>,
): string | null {
  return payload.delta?.stop_reason ?? null;
}

export function emitUsageUpdate(
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

export function emitAnthropicTerminal(
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
