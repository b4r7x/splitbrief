import { z } from 'zod';
import type { ParsedLine } from '../runners/types.js';
import { warnError } from '../../lib/warn.js';

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
    }),
  }),
});

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
  if (text.success) return { text: text.data.part.text };

  const step = OpencodeStepFinishEvent.safeParse(event);
  if (step.success) {
    return {
      usage: {
        inputTokens: step.data.part.tokens.input,
        outputTokens: step.data.part.tokens.output,
      },
    };
  }

  return {};
}
