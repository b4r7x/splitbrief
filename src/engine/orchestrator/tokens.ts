import { assertNever } from '../../utils/type-guards.js';
import type { RunnerCallCounterCoverage } from '../../core/schemas/runner-call.js';
import type { WorkflowState } from '../../core/schemas/workflow/state.js';
import type { TokenUsage, TokenDelta } from '../../core/schemas/tokens.js';
import type { RunnerCallContext, RunnerCallUsage } from '../calls/types.js';
import { combineCoverage } from '../calls/usage/accumulate.js';

export type UsageCategory = 'planner' | 'implementer' | 'escalation' | 'reviewer';

type RunnerCallRole = RunnerCallContext['role'];

type CoreTokenKey = Extract<keyof TokenUsage, `${UsageCategory}${'Input' | 'Output'}`>;
type CacheTokenKey = Extract<keyof TokenUsage, `${UsageCategory}${'CacheRead' | 'CacheCreate'}`>;
type ReasoningTokenKey = Extract<keyof TokenUsage, `${UsageCategory}Reasoning`>;
type CoverageKey = Extract<keyof TokenUsage, `${UsageCategory}Coverage`>;

// Every category owns its five counters. Escalation runs on the planner runner but keeps its own
// cache buckets so its evidence stays attributable; pricing folds the two seats back together in
// core/providers/seat-totals.ts rather than pooling them here.
const categoryFields: Record<
  UsageCategory,
  {
    input: CoreTokenKey;
    output: CoreTokenKey;
    cacheRead: CacheTokenKey;
    cacheCreate: CacheTokenKey;
    reasoning: ReasoningTokenKey;
    coverage: CoverageKey;
  }
> = {
  planner: {
    input: 'plannerInput',
    output: 'plannerOutput',
    cacheRead: 'plannerCacheRead',
    cacheCreate: 'plannerCacheCreate',
    reasoning: 'plannerReasoning',
    coverage: 'plannerCoverage',
  },
  implementer: {
    input: 'implementerInput',
    output: 'implementerOutput',
    cacheRead: 'implementerCacheRead',
    cacheCreate: 'implementerCacheCreate',
    reasoning: 'implementerReasoning',
    coverage: 'implementerCoverage',
  },
  escalation: {
    input: 'escalationInput',
    output: 'escalationOutput',
    cacheRead: 'escalationCacheRead',
    cacheCreate: 'escalationCacheCreate',
    reasoning: 'escalationReasoning',
    coverage: 'escalationCoverage',
  },
  reviewer: {
    input: 'reviewerInput',
    output: 'reviewerOutput',
    cacheRead: 'reviewerCacheRead',
    cacheCreate: 'reviewerCacheCreate',
    reasoning: 'reviewerReasoning',
    coverage: 'reviewerCoverage',
  },
};

export function usageCategoryForRunnerCallRole(role: RunnerCallRole): UsageCategory {
  switch (role) {
    case 'implementer':
      return 'implementer';
    case 'escalation':
      return 'escalation';
    case 'review':
      return 'reviewer';
    case 'planner':
    case 'summary':
    case 'compaction':
      return 'planner';
    default:
      return assertNever(role);
  }
}

// One set of category rules for both entry points: the live ledger (addUsage) and the replay of
// recorded calls (addRunnerCallUsageToTokenUsage) must agree, or a reconciled run drifts.
function applyCategoryDelta(
  totals: TokenUsage,
  category: UsageCategory,
  usage: TokenDelta | RunnerCallUsage,
): void {
  const fields = categoryFields[category];
  const seatWasEmpty =
    totals[fields.input] === 0 &&
    totals[fields.output] === 0 &&
    totals[fields.cacheRead] === undefined &&
    totals[fields.cacheCreate] === undefined &&
    totals[fields.reasoning] === undefined;
  totals[fields.input] += usage.inputTokens;
  totals[fields.output] += usage.outputTokens;
  addOptional(totals, fields.cacheRead, usage.cacheReadTokens);
  addOptional(totals, fields.cacheCreate, usage.cacheCreateTokens);
  addOptional(totals, fields.reasoning, usage.reasoningTokens);
  if (usage.counterCoverage !== undefined) {
    const merged = mergeSeatCoverage(totals[fields.coverage], usage.counterCoverage, seatWasEmpty);
    if (merged === undefined) delete totals[fields.coverage];
    else totals[fields.coverage] = merged;
  }
}

// Coverage describes the seat's whole total. The first evidence on an empty seat sets it; later
// evidence that disagrees degrades that category to partial. A seat that already carries counters
// but no coverage is a legacy record — it stays unknown rather than borrowing a new call's word.
function mergeSeatCoverage(
  current: RunnerCallCounterCoverage | undefined,
  next: RunnerCallCounterCoverage,
  seatWasEmpty: boolean,
): RunnerCallCounterCoverage | undefined {
  if (current === undefined) return seatWasEmpty ? { ...next } : undefined;
  return {
    input: combineCoverage(current.input, next.input),
    output: combineCoverage(current.output, next.output),
    cacheRead: combineCoverage(current.cacheRead, next.cacheRead),
    cacheCreate: combineCoverage(current.cacheCreate, next.cacheCreate),
    reasoning: combineCoverage(current.reasoning, next.reasoning),
  };
}

// An unreported counter leaves the bucket absent; a reported zero creates it at 0.
function addOptional(
  totals: TokenUsage,
  key: CacheTokenKey | ReasoningTokenKey,
  value: number | undefined,
): void {
  if (value === undefined) return;
  totals[key] = (totals[key] ?? 0) + value;
}

export function addRunnerCallUsageToTokenUsage(
  totals: TokenUsage,
  role: RunnerCallRole,
  usage: RunnerCallUsage,
): void {
  applyCategoryDelta(totals, usageCategoryForRunnerCallRole(role), usage);
}

export function addUsage(
  state: WorkflowState,
  category: UsageCategory,
  usage: TokenDelta | null | undefined,
): WorkflowState {
  if (!usage) return state;
  const nextUsage: TokenUsage = { ...state.tokenUsage };
  applyCategoryDelta(nextUsage, category, usage);
  return {
    ...state,
    tokenUsage: nextUsage,
  };
}
