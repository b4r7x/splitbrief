import { z } from 'zod';
import { optionalString, isRecord } from '../../../../utils/type-guards.js';
import { toTokenDelta } from '../../../calls/usage/normalize.js';
import type { StreamParseResult } from './result.js';

export const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
export const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string().optional(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

export const ToolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
});

export const AssistantEvent = z.object({
  type: z.literal('assistant'),
  session_id: z.string().optional(),
  message: z.object({ content: z.array(z.unknown()) }),
});

export const InputEchoEvent = z.object({
  type: z.literal('user'),
  parent_tool_use_id: z.null(),
  message: z.object({
    role: z.literal('user'),
    content: z.union([
      z.string(),
      z.array(z.union([TextBlock, z.object({ type: z.literal('image') })])),
    ]),
  }),
});

export const UserEvent = z.object({
  type: z.literal('user'),
  session_id: z.string().optional(),
  message: z.object({ content: z.array(z.unknown()) }),
});

export const ResultEvent = z.object({
  type: z.literal('result'),
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  session_id: z.string().optional(),
  usage: z.unknown().optional(),
  structured_output: z.unknown().optional(),
});

export const SessionEvent = z.object({
  session_id: z.string(),
});

export const ApiRetryEvent = z.object({
  attempt: z.number(),
  max_retries: z.number(),
  retry_delay_ms: z.number(),
  error_status: z.number().nullable(),
  error: z.string(),
});

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = optionalString(value, { trim: true, nonEmpty: true });
    if (candidate) return candidate;
  }
  return undefined;
}

export function parseStreamEvent(event: Record<string, unknown>): StreamParseResult | null {
  if (event.type !== 'stream_event' || !isRecord(event.event)) return null;
  const streamEvent = event.event;
  const sessionId = firstString(event.session_id, streamEvent.session_id);
  const streamType = firstString(streamEvent.type);

  if (streamType === 'content_block_delta' && isRecord(streamEvent.delta)) {
    const delta = streamEvent.delta;
    if (delta.type === 'text_delta') {
      // Payload text is read verbatim: `firstString` trims and drops
      // whitespace-only values, which is right for ids and discriminants and
      // silently corrupts a message whose slices break on a space or a
      // paragraph gap.
      const text = typeof delta.text === 'string' ? delta.text : undefined;
      return text
        ? { text, channel: 'assistant', textSemantics: 'delta', sessionId }
        : { sessionId };
    }
    if (delta.type === 'input_json_delta') {
      const inputDelta = typeof delta.partial_json === 'string' ? delta.partial_json : '';
      const index = streamEvent.index;
      return {
        sessionId,
        toolUseDelta: [
          {
            ...(typeof index === 'number' ? { id: `content-block-${index}` } : {}),
            inputDelta,
          },
        ],
      };
    }
  }

  if (streamType === 'content_block_start' && isRecord(streamEvent.content_block)) {
    const block = streamEvent.content_block;
    if (block.type === 'tool_use') {
      const name = firstString(block.name) ?? 'tool_use';
      const id = firstString(block.id);
      return {
        sessionId,
        toolUseStart: [
          {
            ...(id !== undefined && { id }),
            name,
            input: isRecord(block.input) ? block.input : {},
          },
        ],
      };
    }
  }

  if (streamType === 'message_start') return { sessionId, isMessageStart: true };

  if (streamType === 'message_delta') {
    const stopReason = isRecord(streamEvent.delta)
      ? firstString(streamEvent.delta.stop_reason)
      : undefined;
    const usage = isRecord(streamEvent.usage) ? toTokenDelta(streamEvent.usage) : null;
    return {
      sessionId,
      ...(usage && { usage, usageSemantics: 'cumulative' }),
      ...(stopReason !== undefined && { stopReason }),
    };
  }

  return { sessionId };
}
