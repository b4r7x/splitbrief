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
  // Defaulted, not required: session state written before reviewer accounting has neither key.
  reviewerInput: z.number().int().nonnegative().default(0),
  reviewerOutput: z.number().int().nonnegative().default(0),
  plannerCacheRead: z.number().nonnegative().optional(),
  plannerCacheCreate: z.number().nonnegative().optional(),
  implementerCacheRead: z.number().nonnegative().optional(),
  implementerCacheCreate: z.number().nonnegative().optional(),
  reviewerCacheRead: z.number().nonnegative().optional(),
  reviewerCacheCreate: z.number().nonnegative().optional(),
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

export const TASK_USAGE_METADATA_KEYS = [
  'implementerCacheReadTokens',
  'implementerCacheCreateTokens',
  'escalationCacheReadTokens',
  'escalationCacheCreateTokens',
  'implementerProfile',
  'contextFit',
  'estimatedTokens',
  'untruncatedEstimatedTokens',
  'contextLength',
  'currentCodeTruncated',
  'currentCodeContextMode',
  'costPosture',
  'routingReason',
] as const;

export const TASK_USAGE_ATTEMPT_KEYS = ['tool', 'model', ...TASK_USAGE_METADATA_KEYS] as const;

export function definedTaskUsageFields<K extends keyof TaskTokenUsage>(
  source: { readonly [P in K]?: TaskTokenUsage[P] },
  keys: readonly K[],
): { [P in K]?: TaskTokenUsage[P] } {
  const fields: { [P in K]?: TaskTokenUsage[P] } = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) fields[key] = value;
  }
  return fields;
}

// Frozen because every zero state in the process is a spread of this one object,
// and the token accumulators mutate their totals argument in place.
export const ZERO_TOKEN_USAGE: Readonly<TokenUsage> = Object.freeze({
  plannerInput: 0,
  plannerOutput: 0,
  implementerInput: 0,
  implementerOutput: 0,
  escalationInput: 0,
  escalationOutput: 0,
  reviewerInput: 0,
  reviewerOutput: 0,
});

export function totalInputTokens(u: TokenUsage): number {
  return u.plannerInput + u.implementerInput + u.escalationInput + u.reviewerInput;
}

export function totalOutputTokens(u: TokenUsage): number {
  return u.plannerOutput + u.implementerOutput + u.escalationOutput + u.reviewerOutput;
}
