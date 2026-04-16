import { z } from 'zod';
import type { TokenDelta } from '../../types.js';

export const TokenUsageLikeSchema = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

export type TokenUsageLike = z.infer<typeof TokenUsageLikeSchema>;

export function toTokenDelta(raw: unknown): TokenDelta | null {
  if (!raw) return null;

  const parsed = TokenUsageLikeSchema.safeParse(raw);
  if (!parsed.success) return null;

  const r = parsed.data;

  const input = r.input_tokens ?? r.prompt_tokens ?? r.inputTokens;
  const output = r.output_tokens ?? r.completion_tokens ?? r.outputTokens;

  if (input == null && output == null) return null;

  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
  };
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
