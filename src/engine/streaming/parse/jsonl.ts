import { z } from 'zod';
import { narrowRecord } from '../../../utils/type-guards.js';
import type { ParsedLine } from '../../runners/types.js';
import { parseCodexToolItem } from './codex-item.js';
import {
  parsedUpstreamFailureWarning,
  parsedUnknownRecordWarning,
  parsedMalformedRecordWarning,
} from './warnings.js';

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
});

const ThreadStartedEvent = z.object({
  type: z.literal('thread.started'),
  thread_id: z.string(),
});

const TurnStartedEvent = z.object({
  type: z.literal('turn.started'),
});

const ItemUpdatedEvent = z.object({
  type: z.literal('item.updated'),
  item: z.record(z.string(), z.unknown()),
});

const TurnFailedEvent = z.object({
  type: z.literal('turn.failed'),
  error: z.object({ message: z.string().optional() }).optional(),
});

const CodexErrorEvent = z.object({
  type: z.literal('error'),
  message: z.string().optional(),
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
        if (texts.length > 0) return { text: texts.join(''), channel: 'assistant' };
      }
      if (item.data.item.text) return { text: item.data.item.text, channel: 'assistant' };
      return {};
    }

    const codexToolItem = parseCodexToolItem(event);
    if (codexToolItem) return codexToolItem;

    if (TurnCompletedEvent.safeParse(event).success) return {};
    if (TurnStartedEvent.safeParse(event).success) return {};
    if (ItemUpdatedEvent.safeParse(event).success) return {};

    const turnFailed = TurnFailedEvent.safeParse(event);
    if (turnFailed.success) {
      return {
        warning: [
          parsedUpstreamFailureWarning({
            parser: 'jsonl',
            upstreamType: 'turn.failed',
            message: turnFailed.data.error?.message ?? 'turn.failed',
          }),
        ],
      };
    }

    const codexError = CodexErrorEvent.safeParse(event);
    if (codexError.success) {
      return {
        warning: [
          parsedUpstreamFailureWarning({
            parser: 'jsonl',
            upstreamType: 'error',
            message: codexError.data.message ?? 'error',
          }),
        ],
      };
    }

    const e = narrowRecord(event);
    if (e !== null) {
      if (typeof e.text === 'string') return { text: e.text, channel: 'assistant' };
      if (e.content != null)
        return {
          text: typeof e.content === 'string' ? e.content : JSON.stringify(e.content),
          channel: 'assistant',
        };
      if (e.type === 'turn.completed') return {};
    }

    const warning = parsedUnknownRecordWarning({ parser: 'jsonl', value: event });
    return warning === null ? {} : { warning: [warning] };
  } catch {
    return {
      warning: [
        parsedMalformedRecordWarning({
          parser: 'jsonl',
          line,
          message: 'Malformed JSONL line skipped',
        }),
      ],
    };
  }
}
