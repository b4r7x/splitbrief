import { z } from 'zod';
import { TaskCompletionMethodSchema } from './enums.js';
import { TaskIdSchema } from './task.js';

export const TokenDeltaSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheCreateTokens: z.number().nonnegative().optional(),
});

export const TokenUsageSchema = z.object({
  plannerInput: z.number(),
  plannerOutput: z.number(),
  implementerInput: z.number(),
  implementerOutput: z.number(),
  escalationInput: z.number(),
  escalationOutput: z.number(),
  plannerCacheRead: z.number().nonnegative().optional(),
  plannerCacheCreate: z.number().nonnegative().optional(),
  implementerCacheRead: z.number().nonnegative().optional(),
  implementerCacheCreate: z.number().nonnegative().optional(),
});

export const TaskTokenUsageSchema = z.object({
  taskId: TaskIdSchema,
  taskTitle: z.string(),
  method: TaskCompletionMethodSchema,
  implementerTokens: z.number().nonnegative(),
  escalationTokens: z.number().nonnegative(),
  retryCount: z.number().nonnegative(),
  cost: z.number().nonnegative().optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
  implementerProfile: z.string().optional(),
  contextFit: z.enum(['fits', 'tight', 'overflow']).optional(),
  estimatedTokens: z.number().nonnegative().optional(),
  untruncatedEstimatedTokens: z.number().nonnegative().optional(),
  contextLength: z.number().nonnegative().optional(),
  currentCodeTruncated: z.boolean().optional(),
  currentCodeContextMode: z.enum(['none', 'whole-file', 'function-level', 'truncated']).optional(),
  costPosture: z.string().optional(),
  routingReason: z.string().optional(),
});

export type TokenDelta = z.infer<typeof TokenDeltaSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type TaskTokenUsage = z.infer<typeof TaskTokenUsageSchema>;
