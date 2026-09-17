import { z } from 'zod';
import type {
  ParsedTextSemantics,
  ParsedUsageSemantics,
  ParsedTextChannel,
  ParsedWarningInfo,
  ToolUseDeltaInfo,
  ToolUseInfo,
} from '../runners/types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { accumulateTokenUsage, BackendTokenUsageSchema, toTokenDelta } from '../calls/usage.js';
import { isRecord, optionalString } from '../../utils/type-guards.js';
import { parsedMalformedRecordWarning, parsedUnknownRecordWarning } from './parser-warnings.js';

export interface StreamParseResult {
  text?: string | undefined;
  channel?: ParsedTextChannel | undefined;
  /** `final` marks text that restates a block already streamed as deltas. */
  textSemantics?: ParsedTextSemantics | undefined;
  sessionId?: string | undefined;
  isResult?: boolean | undefined;
  isError?: boolean | undefined;
  usage?: TokenDelta | undefined;
  usageSemantics?: ParsedUsageSemantics | undefined;
  toolUse?: ToolUseInfo[] | undefined;
  toolUseStart?: ToolUseInfo[] | undefined;
  toolUseDelta?: ToolUseDeltaInfo[] | undefined;
  warning?: ParsedWarningInfo[] | undefined;
}

export const EMPTY_RESULT: StreamParseResult = Object.freeze({});

type MessageUsage = z.infer<typeof BackendTokenUsageSchema>;
type CollectMessageUsage = (event: Record<string, unknown>) => TokenDelta | undefined;

/** One parser per invocation: message snapshots replace, distinct messages add. */
export function createStreamParser(): (line: string) => StreamParseResult {
  const messages = new Map<string, MessageUsage>();
  let activeMessage: string | undefined;

  const collect: CollectMessageUsage = (event) => {
    // The invocation result covers the main loop, not nested subagent messages.
    if (event.parent_tool_use_id != null) return undefined;
    const stream = event.type === 'stream_event' && isRecord(event.event) ? event.event : null;
    const message =
      event.type === 'assistant'
        ? event.message
        : stream?.type === 'message_start'
          ? stream.message
          : undefined;
    let id: string | undefined;
    let raw: unknown;
    if (isRecord(message)) {
      id = firstString(message.id);
      if (stream?.type === 'message_start') activeMessage = id;
      if (!isRecord(message.usage)) return undefined;
      // Assistant/message_start output is a placeholder. Only message_delta or
      // the invocation result establishes the generated count.
      const { output_tokens: _placeholder, ...inputUsage } = message.usage;
      raw = inputUsage;
    } else if (stream?.type === 'message_delta') {
      id = activeMessage;
      raw = stream.usage;
    } else {
      if (stream?.type === 'message_stop') activeMessage = undefined;
      return undefined;
    }
    if (id === undefined) return undefined;
    const parsed = BackendTokenUsageSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    messages.set(id, { ...messages.get(id), ...parsed.data });

    let aggregate: TokenDelta | null = null;
    let outputTotal = 0;
    let allOutputsKnown = true;
    for (const value of messages.values()) {
      const usage = toTokenDelta(value);
      if (usage === null) continue;
      aggregate = accumulateTokenUsage(aggregate, usage);
      if (usage.providerTotals?.output === undefined) allOutputsKnown = false;
      else outputTotal += usage.providerTotals.output;
    }
    if (aggregate === null) return undefined;
    const { providerTotals: _lastMessageTotals, ...counters } = aggregate;
    return {
      ...counters,
      ...(allOutputsKnown && { providerTotals: { output: outputTotal } }),
    };
  };
  return (line) => parseLine(line, collect);
}

const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
  id: z.string().optional(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const AssistantEvent = z.object({
  type: z.literal('assistant'),
  session_id: z.string().optional(),
  message: z.object({ content: z.array(z.unknown()) }),
});

const ResultEvent = z.object({
  type: z.literal('result'),
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  session_id: z.string().optional(),
  usage: z.unknown().optional(),
});

const SessionEvent = z.object({
  session_id: z.string(),
});

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = optionalString(value, { trim: true, nonEmpty: true });
    if (candidate) return candidate;
  }
  return undefined;
}

function parseStreamEvent(event: Record<string, unknown>): StreamParseResult | null {
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
      return text ? { text, channel: 'assistant', sessionId } : { sessionId };
    }
    if (delta.type === 'input_json_delta') {
      const inputDelta = firstString(delta.partial_json) ?? '';
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

  if (streamType === 'message_delta' && isRecord(streamEvent.usage)) {
    const usage = toTokenDelta(streamEvent.usage);
    return usage ? { sessionId, usage, usageSemantics: 'cumulative' } : { sessionId };
  }

  return { sessionId };
}

function parseSystemProgress(event: Record<string, unknown>): StreamParseResult | null {
  const type = firstString(event.type);
  if (!type) return null;
  const sessionId = firstString(event.session_id);
  if (type === 'system') {
    const subtype = firstString(event.subtype);
    return subtype ? { text: subtype, channel: 'system', sessionId } : { sessionId };
  }
  if (type === 'api_error' || type === 'api_retry' || type === 'plugin_progress') {
    return {
      text: type,
      channel: 'system',
      sessionId,
      warning:
        type === 'api_error'
          ? [{ code: 'claude_api_error', message: firstString(event.message) ?? type }]
          : undefined,
    };
  }
  return null;
}

export function parseStreamLine(line: string): StreamParseResult {
  return parseLine(line);
}

function parseLine(line: string, collectUsage?: CollectMessageUsage): StreamParseResult {
  if (!line.trim()) return EMPTY_RESULT;

  try {
    const event: unknown = JSON.parse(line);
    const record = isRecord(event) ? event : null;
    const usage = record === null ? undefined : collectUsage?.(record);

    const assistant = AssistantEvent.safeParse(event);
    if (assistant.success) {
      const texts: string[] = [];
      const tools: ToolUseInfo[] = [];
      for (const raw of assistant.data.message.content) {
        const tb = TextBlock.safeParse(raw);
        if (tb.success) {
          texts.push(tb.data.text);
          continue;
        }
        const tu = ToolUseBlock.safeParse(raw);
        if (tu.success) {
          tools.push({
            ...(tu.data.id !== undefined && { id: tu.data.id }),
            name: tu.data.name,
            input: tu.data.input ?? {},
          });
        }
      }
      return {
        text: texts.length > 0 ? texts.join('') : undefined,
        channel: texts.length > 0 ? 'assistant' : undefined,
        // A non-partial `assistant` record restates the whole block whose
        // `text_delta` slices already streamed; it replaces them, never appends.
        textSemantics: texts.length > 0 ? 'final' : undefined,
        sessionId: assistant.data.session_id ?? undefined,
        toolUse: tools.length > 0 ? tools : undefined,
        ...(usage !== undefined && { usage, usageSemantics: 'cumulative' }),
      };
    }

    const result = ResultEvent.safeParse(event);
    if (result.success) {
      const usage = toTokenDelta(result.data.usage ?? undefined) ?? undefined;
      return {
        text: result.data.result ?? undefined,
        channel: result.data.result !== undefined ? 'result' : undefined,
        sessionId: result.data.session_id ?? undefined,
        isResult: true,
        ...(result.data.is_error !== undefined && { isError: result.data.is_error }),
        ...(usage !== undefined && { usage, usageSemantics: 'final' }),
      };
    }

    if (record) {
      const streamEvent = parseStreamEvent(record);
      if (streamEvent) {
        if (collectUsage === undefined) return streamEvent;
        const { usage: _messageUsage, usageSemantics: _semantics, ...rest } = streamEvent;
        return { ...rest, ...(usage !== undefined && { usage, usageSemantics: 'cumulative' }) };
      }
      const systemProgress = parseSystemProgress(record);
      if (systemProgress) return systemProgress;
    }

    const session = SessionEvent.safeParse(event);
    if (session.success) {
      return { sessionId: session.data.session_id };
    }

    const warning = parsedUnknownRecordWarning({ parser: 'stream-json', value: event });
    return warning === null ? EMPTY_RESULT : { warning: [warning] };
  } catch {
    return {
      warning: [
        parsedMalformedRecordWarning({
          parser: 'stream-json',
          line,
          message: 'Malformed stream-json line skipped',
        }),
      ],
    };
  }
}
