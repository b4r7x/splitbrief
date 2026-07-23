import { z } from 'zod';
import type { ParsedLine } from '../runners/types.js';
import { BackendTokenUsageSchema, toTokenDelta } from '../calls/usage.js';
import { parsedMalformedRecordWarning, parsedUnknownRecordWarning } from './parser-warnings.js';

const TextBlock = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const SessionStartEvent = z.object({
  type: z.literal('session.start'),
  data: z.looseObject({
    sessionId: z.string().optional(),
    id: z.string().optional(),
  }),
});

const AssistantMessageEvent = z.object({
  type: z.literal('assistant.message'),
  data: z.looseObject({
    text: z.string().optional(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
    usage: BackendTokenUsageSchema.optional(),
  }),
});

const AssistantUsageEvent = z.object({
  type: z.literal('assistant.usage'),
  data: z.looseObject({
    usage: BackendTokenUsageSchema.optional(),
  }),
});

const ToolUseEvent = z.object({
  type: z.enum(['tool.execution_start', 'tool.call', 'tool.use']),
  data: z.looseObject({
    name: z.string().optional(),
    id: z.string().optional(),
    tool: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
});

function extractText(data: z.infer<typeof AssistantMessageEvent>['data']): string | undefined {
  if (data.text) return data.text;
  if (typeof data.content === 'string') return data.content;
  if (Array.isArray(data.content)) {
    const texts: string[] = [];
    for (const raw of data.content) {
      const block = TextBlock.safeParse(raw);
      if (block.success) texts.push(block.data.text);
    }
    if (texts.length > 0) return texts.join('');
  }
  return undefined;
}

export function parseCopilotLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return {};

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return {
      warning: [
        parsedMalformedRecordWarning({
          parser: 'copilot',
          line: trimmed,
          message: 'Malformed copilot JSON line skipped',
        }),
      ],
    };
  }

  const session = SessionStartEvent.safeParse(event);
  if (session.success) {
    const id = session.data.data.sessionId ?? session.data.data.id;
    if (id) return { sessionId: id };
  }

  const message = AssistantMessageEvent.safeParse(event);
  if (message.success) {
    const text = extractText(message.data.data);
    const usage = message.data.data.usage ? toTokenDelta(message.data.data.usage) : null;
    if (text !== undefined && usage) return { text, channel: 'assistant', usage };
    if (text !== undefined) return { text, channel: 'assistant' };
    if (usage) return { usage };
  }

  const usageEvent = AssistantUsageEvent.safeParse(event);
  if (usageEvent.success && usageEvent.data.data.usage) {
    const usage = toTokenDelta(usageEvent.data.data.usage);
    if (usage) return { usage };
  }

  const tool = ToolUseEvent.safeParse(event);
  if (tool.success) {
    const name = tool.data.data.name ?? tool.data.data.tool;
    if (name) {
      return {
        toolUse: [
          {
            ...(tool.data.data.id !== undefined && { id: tool.data.data.id }),
            name,
            input: tool.data.data.input ?? tool.data.data.args ?? {},
          },
        ],
      };
    }
  }

  const warning = parsedUnknownRecordWarning({ parser: 'copilot', value: event });
  return warning === null ? {} : { warning: [warning] };
}
