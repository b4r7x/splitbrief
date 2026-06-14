import { z } from 'zod';
import type { ToolUseInfo } from '../runners/types.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import { toTokenDelta } from './token-usage.js';
import { warnError } from '../../lib/warn.js';

export interface StreamParseResult {
  text?: string | undefined;
  sessionId?: string | undefined;
  isResult?: boolean | undefined;
  isError?: boolean | undefined;
  usage?: TokenDelta | undefined;
  toolUse?: ToolUseInfo[] | undefined;
}

export const EMPTY_RESULT: StreamParseResult = Object.freeze({});

const TextBlock = z.object({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.object({
  type: z.literal('tool_use'),
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
  usage: z.unknown(),
});

const SessionEvent = z.object({
  session_id: z.string(),
});

export function parseStreamLine(line: string): StreamParseResult {
  if (!line.trim()) return EMPTY_RESULT;

  try {
    const event: unknown = JSON.parse(line);

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
          tools.push({ name: tu.data.name, input: tu.data.input ?? {} });
        }
      }
      return {
        text: texts.length > 0 ? texts.join('') : undefined,
        sessionId: assistant.data.session_id ?? undefined,
        toolUse: tools.length > 0 ? tools : undefined,
      };
    }

    const result = ResultEvent.safeParse(event);
    if (result.success) {
      return {
        text: result.data.result ?? undefined,
        sessionId: result.data.session_id ?? undefined,
        isResult: true,
        isError: result.data.is_error ?? undefined,
        usage: toTokenDelta(result.data.usage ?? undefined) ?? undefined,
      };
    }

    const session = SessionEvent.safeParse(event);
    if (session.success) {
      return { sessionId: session.data.session_id };
    }

    return EMPTY_RESULT;
  } catch (err) {
    warnError('output-parser: malformed stream-json line', err);
    return EMPTY_RESULT;
  }
}
