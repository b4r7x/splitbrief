import { z } from 'zod';
import type {
  ParsedUsageSemantics,
  ParsedTextChannel,
  ParsedWarningInfo,
  ToolUseDeltaInfo,
  ToolUseInfo,
} from '../runners/types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { toTokenDelta } from '../calls/usage.js';
import { isRecord, optionalString } from '../../utils/type-guards.js';
import { parsedMalformedRecordWarning, parsedUnknownRecordWarning } from './parser-warnings.js';

export interface StreamParseResult {
  text?: string | undefined;
  channel?: ParsedTextChannel | undefined;
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
      const text = firstString(delta.text);
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
  if (!line.trim()) return EMPTY_RESULT;

  try {
    const event: unknown = JSON.parse(line);
    const record = isRecord(event) ? event : null;

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
        sessionId: assistant.data.session_id ?? undefined,
        toolUse: tools.length > 0 ? tools : undefined,
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
      if (streamEvent) return streamEvent;
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
