import { z } from 'zod';
import {
  CurrentCodeContextModeSchema,
  TaskCompletionMethodSchema,
  TaskContextFitSchema,
} from './enums.js';
import { TaskIdSchema } from './task.js';

export interface TokenDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  reasoningTokens?: number;
}

export const TokenUsageSchema = z.object({
  plannerInput: z.number().int().nonnegative(),
  plannerOutput: z.number().int().nonnegative(),
  implementerInput: z.number().int().nonnegative(),
  implementerOutput: z.number().int().nonnegative(),
  escalationInput: z.number().int().nonnegative(),
  escalationOutput: z.number().int().nonnegative(),
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
  implementerCacheReadTokens: z.number().nonnegative().optional(),
  implementerCacheCreateTokens: z.number().nonnegative().optional(),
  escalationCacheReadTokens: z.number().nonnegative().optional(),
  escalationCacheCreateTokens: z.number().nonnegative().optional(),
  retryCount: z.number().nonnegative(),
  cost: z.number().nonnegative().optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
  implementerProfile: z.string().optional(),
  contextFit: TaskContextFitSchema.optional(),
  estimatedTokens: z.number().nonnegative().optional(),
  untruncatedEstimatedTokens: z.number().nonnegative().optional(),
  contextLength: z.number().nonnegative().optional(),
  currentCodeTruncated: z.boolean().optional(),
  currentCodeContextMode: CurrentCodeContextModeSchema.optional(),
  costPosture: z.string().optional(),
  routingReason: z.string().optional(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type TaskTokenUsage = z.infer<typeof TaskTokenUsageSchema>;

export function totalInputTokens(u: TokenUsage): number {
  return u.plannerInput + u.implementerInput + u.escalationInput;
}

export function totalOutputTokens(u: TokenUsage): number {
  return u.plannerOutput + u.implementerOutput + u.escalationOutput;
}
