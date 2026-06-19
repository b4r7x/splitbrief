import { z } from 'zod';
import type { ParsedLine } from '../runners/types.js';
import { TokenUsageLikeSchema, toTokenDelta } from './token-usage.js';
import { isRecord, narrowRecord, optionalString } from '../../utils/type-guards.js';
import { warnError } from '../../lib/warn.js';

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
  usage: TokenUsageLikeSchema,
});

const ThreadStartedEvent = z.object({
  type: z.literal('thread.started'),
  thread_id: z.string(),
});

const CodexItemEvent = z.object({
  type: z.enum(['item.started', 'item.completed']),
  item: z.record(z.string(), z.unknown()),
});

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = optionalString(value, { trim: true, nonEmpty: true });
    if (candidate) return candidate;
  }
  return undefined;
}

function codexToolName(item: Record<string, unknown>): string | null {
  const itemType = firstString(item.type);
  if (!itemType || itemType === 'agent_message') return null;
  return (
    firstString(item.name, item.tool_name, item.command, item.operation, item.action, itemType) ??
    null
  );
}

function codexToolInput(item: Record<string, unknown>): Record<string, unknown> {
  const explicit = item.input ?? item.arguments ?? item.args;
  if (isRecord(explicit)) return explicit;
  const input: Record<string, unknown> = {};
  for (const key of [
    'type',
    'command',
    'path',
    'file',
    'file_path',
    'query',
    'url',
    'server',
    'tool_name',
    'status',
  ]) {
    if (item[key] !== undefined) input[key] = item[key];
  }
  return input;
}

function codexToolOutput(item: Record<string, unknown>): unknown {
  return item.output ?? item.result ?? item.text ?? item.content ?? item.status;
}

function parseCodexToolItem(event: unknown): ParsedLine | null {
  const parsed = CodexItemEvent.safeParse(event);
  if (!parsed.success) return null;
  const { item } = parsed.data;
  const name = codexToolName(item);
  if (!name) return null;
  const id = firstString(item.id, item.item_id, item.call_id);
  const toolUse = {
    ...(id !== undefined && { id }),
    name,
    input: codexToolInput(item),
  };
  if (parsed.data.type === 'item.started') return { toolUseStart: [toolUse] };
  const output = codexToolOutput(item);
  return {
    toolUseDone: [
      {
        ...toolUse,
        ...(output !== undefined && { output }),
      },
    ],
  };
}

export function parseJsonlLine(line: string): ParsedLine {
  if (!line.trim()) return {};

  try {
    const event: unknown = JSON.parse(line);

    const thread = ThreadStartedEvent.safeParse(event);
    if (thread.success) {
      return { sessionId: thread.data.thread_id };
    }

    const item = ItemCompletedEvent.safeParse(event);
    if (item.success) {
      if (item.data.item.content) {
        const texts: string[] = [];
        for (const raw of item.data.item.content) {
          const tb = JsonlTextBlock.safeParse(raw);
          if (tb.success) texts.push(tb.data.text);
        }
        if (texts.length > 0) return { text: texts.join(''), channel: 'assistant' };
      }
      if (item.data.item.text) return { text: item.data.item.text, channel: 'assistant' };
    }

    const codexToolItem = parseCodexToolItem(event);
    if (codexToolItem) return codexToolItem;

    const turn = TurnCompletedEvent.safeParse(event);
    if (turn.success) {
      const usage = toTokenDelta(turn.data.usage);
      if (usage) return { usage };
    }

    const e = narrowRecord(event);
    if (e !== null) {
      if (typeof e.text === 'string') return { text: e.text, channel: 'assistant' };
      if (e.content != null)
        return {
          text: typeof e.content === 'string' ? e.content : JSON.stringify(e.content),
          channel: 'assistant',
        };
    }

    return {};
  } catch (err) {
    warnError('output-parser: malformed JSONL line', err);
    return {};
  }
}
