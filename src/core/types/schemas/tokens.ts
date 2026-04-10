import { z } from 'zod';

export const TokenDeltaSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export const TokenUsageSchema = z.object({
  plannerInput: z.number(),
  plannerOutput: z.number(),
  implementerInput: z.number(),
  implementerOutput: z.number(),
  escalationInput: z.number(),
  escalationOutput: z.number(),
});
