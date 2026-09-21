import { z } from 'zod';
import {
  RunnerCallCounterCoverageSchema,
  type RunnerCallCounterCoverage,
  type RunnerCallProviderTotals,
} from '../runner-call-contract.js';
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
  counterCoverage?: RunnerCallCounterCoverage;
  providerTotals?: RunnerCallProviderTotals;
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
  // Escalation runs on the planner runner but keeps its own cache buckets, so new evidence is
  // attributable. A record written before these fields pooled escalation cache into the planner
  // buckets; absent here means unknown, and that pooled amount is never re-read as escalation.
  escalationCacheRead: z.number().nonnegative().optional(),
  escalationCacheCreate: z.number().nonnegative().optional(),
  // Reasoning is disjoint from the *Output counters. Absent means the provider never reported it.
  plannerReasoning: z.number().nonnegative().optional(),
  implementerReasoning: z.number().nonnegative().optional(),
  escalationReasoning: z.number().nonnegative().optional(),
  reviewerReasoning: z.number().nonnegative().optional(),
  plannerCoverage: RunnerCallCounterCoverageSchema.optional(),
  implementerCoverage: RunnerCallCounterCoverageSchema.optional(),
  escalationCoverage: RunnerCallCounterCoverageSchema.optional(),
  reviewerCoverage: RunnerCallCounterCoverageSchema.optional(),
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
  // Directional and reasoning counters, written only from a delta the ledger actually knows.
  // A historical record carries the combined *Tokens count alone; its split is unknown, not zero.
  implementerInputTokens: z.number().nonnegative().optional(),
  implementerOutputTokens: z.number().nonnegative().optional(),
  implementerReasoningTokens: z.number().nonnegative().optional(),
  escalationInputTokens: z.number().nonnegative().optional(),
  escalationOutputTokens: z.number().nonnegative().optional(),
  escalationReasoningTokens: z.number().nonnegative().optional(),
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
  routingReason: z.string().optional(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type TaskTokenUsage = z.infer<typeof TaskTokenUsageSchema>;

export const TASK_USAGE_METADATA_KEYS = [
  'implementerCacheReadTokens',
  'implementerCacheCreateTokens',
  'escalationCacheReadTokens',
  'escalationCacheCreateTokens',
  'implementerInputTokens',
  'implementerOutputTokens',
  'implementerReasoningTokens',
  'escalationInputTokens',
  'escalationOutputTokens',
  'escalationReasoningTokens',
  'implementerProfile',
  'contextFit',
  'estimatedTokens',
  'untruncatedEstimatedTokens',
  'contextLength',
  'currentCodeTruncated',
  'currentCodeContextMode',
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

// The *Output counters are ordinary output only. Generated tokens are output plus the reasoning
// the provider reported, counted here exactly once; a seat that reported no reasoning adds nothing
// rather than an invented zero.
export function totalOutputTokens(u: TokenUsage): number {
  return (
    u.plannerOutput +
    u.implementerOutput +
    u.escalationOutput +
    u.reviewerOutput +
    (u.plannerReasoning ?? 0) +
    (u.implementerReasoning ?? 0) +
    (u.escalationReasoning ?? 0) +
    (u.reviewerReasoning ?? 0)
  );
}
