import { z } from 'zod';
import type { OutputFormat, ParsedLine, TokenDelta } from '../../types.js';
import { toTokenDelta } from './token-utils.js';

export interface ToolUseInfo {
  name: string;
  input: Record<string, unknown>;
}

interface StreamParseResult {
  text?: string | undefined;
  sessionId?: string | undefined;
  isResult?: boolean | undefined;
  usage?: TokenDelta | undefined;
  toolUse?: ToolUseInfo[] | undefined;
}

const EMPTY_RESULT: StreamParseResult = Object.freeze({});

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
  session_id: z.string().optional(),
  usage: z.record(z.string(), z.unknown()).optional(),
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
        if (tb.success) { texts.push(tb.data.text); continue; }
        const tu = ToolUseBlock.safeParse(raw);
        if (tu.success) { tools.push({ name: tu.data.name, input: tu.data.input ?? {} }); }
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
        usage: toTokenDelta(result.data.usage ?? undefined) ?? undefined,
      };
    }

    const session = SessionEvent.safeParse(event);
    if (session.success) {
      return { sessionId: session.data.session_id };
    }

    return EMPTY_RESULT;
  } catch { /* malformed stream-json line — skip */
    return EMPTY_RESULT;
  }
}

export function parseTextLine(line: string): ParsedLine {
  if (!line.trim()) return {};

  const tokenMatch = line.match(/Tokens:\s*([\d.]+k?)\s*sent,\s*([\d.]+k?)\s*received/i);
  if (tokenMatch?.[1] && tokenMatch[2]) {
    const parseK = (v: string) => {
      const n = parseFloat(v);
      return v.toLowerCase().endsWith('k') ? Math.round(n * 1000) : Math.round(n);
    };
    return { usage: { inputTokens: parseK(tokenMatch[1]), outputTokens: parseK(tokenMatch[2]) } };
  }

  return { text: line + '\n' };
}

const JsonlTextBlock = z.object({
  type: z.enum(['text', 'output_text']),
  text: z.string(),
});

const ItemCompletedEvent = z.object({
  type: z.literal('item.completed'),
  item: z.object({
    type: z.literal('agent_message'),
    content: z.array(z.unknown()).optional(),
    text: z.string().optional(),
  }),
});

const TurnCompletedEvent = z.object({
  type: z.literal('turn.completed'),
  usage: z.record(z.string(), z.unknown()),
});

export function parseJsonlLine(line: string): ParsedLine {
  if (!line.trim()) return {};

  try {
    const event: unknown = JSON.parse(line);

    const item = ItemCompletedEvent.safeParse(event);
    if (item.success) {
      if (item.data.item.content) {
        const texts: string[] = [];
        for (const raw of item.data.item.content) {
          const tb = JsonlTextBlock.safeParse(raw);
          if (tb.success) texts.push(tb.data.text);
        }
        if (texts.length > 0) return { text: texts.join('') };
      }
      if (item.data.item.text) return { text: item.data.item.text };
    }

    const turn = TurnCompletedEvent.safeParse(event);
    if (turn.success) {
      const usage = toTokenDelta(turn.data.usage);
      if (usage) return { usage };
    }

    // Fallback for simple text/content events — too simple for schemas
    if (typeof event === 'object' && event !== null) {
      const e = event as Record<string, unknown>;
      if (typeof e.text === 'string') return { text: e.text };
      if (e.content != null) return { text: typeof e.content === 'string' ? e.content : JSON.stringify(e.content) };
    }

    return {};
  } catch { /* malformed JSONL line — skip */
    return {};
  }
}

export function getLineParser(format: OutputFormat): (line: string) => ParsedLine {
  switch (format) {
    case 'stream-json': return parseStreamLine;
    case 'jsonl': return parseJsonlLine;
    case 'text': return parseTextLine;
    case 'opencode': return parseOpencodeLine;
  }
}

const OpencodeTextEvent = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const OpencodeStepFinishEvent = z.object({
  type: z.literal('step_finish'),
  usage: z.object({
    tokens: z.object({
      input: z.number(),
      output: z.number(),
    }),
  }),
});

export function parseOpencodeLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return {};

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch { /* malformed opencode JSON — skip */
    return {};
  }

  const text = OpencodeTextEvent.safeParse(event);
  if (text.success) return { text: text.data.text };

  const step = OpencodeStepFinishEvent.safeParse(event);
  if (step.success) {
    return { usage: { inputTokens: step.data.usage.tokens.input, outputTokens: step.data.usage.tokens.output } };
  }

  return {};
}

export function accumulateUsage(
  current: TokenDelta | null,
  delta: TokenDelta,
): TokenDelta {
  if (current) {
    return {
      inputTokens: current.inputTokens + delta.inputTokens,
      outputTokens: current.outputTokens + delta.outputTokens,
    };
  }
  return { ...delta };
}
