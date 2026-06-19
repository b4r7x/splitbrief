import { z } from 'zod';
import type { ParsedLine } from '../runners/types.js';
import { warnError } from '../../lib/warn.js';

const OpencodeBaseEvent = z.looseObject({
  sessionID: z.string().optional(),
  sessionId: z.string().optional(),
});

const OpencodeTextEvent = z.object({
  type: z.literal('text'),
  part: z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
});

const OpencodeStepFinishEvent = z.object({
  type: z.literal('step_finish'),
  part: z.object({
    type: z.literal('step-finish'),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      cache: z
        .object({
          read: z.number().optional(),
          write: z.number().optional(),
        })
        .optional(),
    }),
  }),
});

const OpencodeToolEvent = z.object({
  type: z.enum(['tool_use', 'tool_call', 'tool', 'tool_start', 'tool_finish', 'tool_result']),
  part: z.looseObject({
    type: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    tool: z.string().optional(),
    state: z.string().optional(),
    status: z.string().optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    output: z.unknown().optional(),
    result: z.unknown().optional(),
  }),
});

function withSession(result: ParsedLine, event: unknown): ParsedLine {
  const base = OpencodeBaseEvent.safeParse(event);
  if (!base.success) return result;
  const sessionId = base.data.sessionID ?? base.data.sessionId;
  return sessionId ? { ...result, sessionId } : result;
}

export function parseOpencodeLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return {};

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch (err) {
    warnError('output-parser: malformed opencode JSON', err);
    return {};
  }

  const text = OpencodeTextEvent.safeParse(event);
  if (text.success) return withSession({ text: text.data.part.text, channel: 'assistant' }, event);

  const step = OpencodeStepFinishEvent.safeParse(event);
  if (step.success) {
    const { tokens } = step.data.part;
    return withSession(
      {
        usage: {
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          ...(tokens.cache?.read !== undefined && { cacheReadTokens: tokens.cache.read }),
          ...(tokens.cache?.write !== undefined && { cacheCreateTokens: tokens.cache.write }),
        },
      },
      event,
    );
  }

  const tool = OpencodeToolEvent.safeParse(event);
  if (tool.success) {
    const name = tool.data.part.name ?? tool.data.part.tool;
    if (name) {
      const toolUse = {
        ...(tool.data.part.id !== undefined && { id: tool.data.part.id }),
        name,
        input: tool.data.part.input ?? tool.data.part.args ?? {},
        ...(tool.data.part.output !== undefined && { output: tool.data.part.output }),
        ...(tool.data.part.result !== undefined && { output: tool.data.part.result }),
      };
      const isDone =
        tool.data.type === 'tool_finish' ||
        tool.data.type === 'tool_result' ||
        tool.data.part.state === 'completed' ||
        tool.data.part.status === 'completed' ||
        tool.data.part.status === 'done';
      return withSession(isDone ? { toolUseDone: [toolUse] } : { toolUseStart: [toolUse] }, event);
    }
  }

  return withSession({}, event);
}
