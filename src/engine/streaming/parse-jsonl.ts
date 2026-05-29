import { z } from 'zod';
import type { ParsedLine } from '../runners/types.js';
import { TokenUsageLikeSchema, toTokenDelta } from './token-utils.js';
import { narrowRecord } from '../../utils/type-guards.js';
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
        if (texts.length > 0) return { text: texts.join('') };
      }
      if (item.data.item.text) return { text: item.data.item.text };
    }

    const turn = TurnCompletedEvent.safeParse(event);
    if (turn.success) {
      const usage = toTokenDelta(turn.data.usage);
      if (usage) return { usage };
    }

    const e = narrowRecord(event);
    if (e !== null) {
      if (typeof e.text === 'string') return { text: e.text };
      if (e.content != null)
        return { text: typeof e.content === 'string' ? e.content : JSON.stringify(e.content) };
    }

    return {};
  } catch (err) {
    warnError('output-parser: malformed JSONL line', err);
    return {};
  }
}
