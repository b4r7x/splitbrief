import { z } from 'zod';
import type { TokenDelta } from '../../core/schemas/tokens.js';

export const TokenUsageLikeSchema = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  prompt_tokens_details: z
    .object({
      cached_tokens: z.number().optional(),
    })
    .optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreateTokens: z.number().optional(),
});

export function toTokenDelta(raw: unknown): TokenDelta | null {
  if (!raw) return null;

  const parsed = TokenUsageLikeSchema.safeParse(raw);
  if (!parsed.success) return null;

  const r = parsed.data;

  const cacheRead =
    r.cache_read_input_tokens ?? r.prompt_tokens_details?.cached_tokens ?? r.cacheReadTokens;
  const promptInput =
    r.prompt_tokens === undefined
      ? undefined
      : Math.max(0, r.prompt_tokens - (r.prompt_tokens_details?.cached_tokens ?? 0));
  const input = r.input_tokens ?? promptInput ?? r.inputTokens;
  const output = r.output_tokens ?? r.completion_tokens ?? r.outputTokens;
  const cacheCreate = r.cache_creation_input_tokens ?? r.cacheCreateTokens;

  if (input == null && output == null && cacheRead == null && cacheCreate == null) return null;

  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }),
    ...(cacheCreate !== undefined && { cacheCreateTokens: cacheCreate }),
  };
}

export function accumulateUsage(current: TokenDelta | null, delta: TokenDelta): TokenDelta {
  if (current) {
    return {
      inputTokens: current.inputTokens + delta.inputTokens,
      outputTokens: current.outputTokens + delta.outputTokens,
      ...((current.cacheReadTokens !== undefined || delta.cacheReadTokens !== undefined) && {
        cacheReadTokens: (current.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
      }),
      ...((current.cacheCreateTokens !== undefined || delta.cacheCreateTokens !== undefined) && {
        cacheCreateTokens: (current.cacheCreateTokens ?? 0) + (delta.cacheCreateTokens ?? 0),
      }),
    };
  }
  return { ...delta };
}
