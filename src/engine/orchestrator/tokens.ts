import { assertNever } from '../../utils/type-guards.js';
import type {
  RunnerCallCounterCoverage,
  RunnerCallCounterCoverageState,
} from '../../core/runner-call-contract.js';
import type { Task, TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import {
  definedTaskUsageFields,
  TASK_USAGE_ATTEMPT_KEYS,
  type TokenUsage,
  type TokenDelta,
  type TaskTokenUsage,
} from '../../core/schemas/tokens.js';
import type { EventBus } from '../events/types.js';
import type { RoutingDecision } from './context-routing/types.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { RunnerCallUsage } from '../calls/types.js';
import { publishWarning } from './events.js';

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

function combineCoverage(
  left: RunnerCallCounterCoverageState,
  right: RunnerCallCounterCoverageState,
): RunnerCallCounterCoverageState {
  return left === right ? left : 'partial';
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

function clampNonNegative(value: number): number {
  return Math.max(0, value);
}

// A reasoning delta exists only where the ledger has a reasoning bucket to compare. No bucket
// means the seat's provider never reported reasoning: unknown, which is not a zero to persist.
function knownDelta(before: number | undefined, after: number | undefined): number | undefined {
  if (after === undefined) return undefined;
  return clampNonNegative(after - (before ?? 0));
}

type TaskUsageDelta = {
  implementerTokens: number;
  escalationTokens: number;
  implementerInputTokens: number;
  implementerOutputTokens: number;
  escalationInputTokens: number;
  escalationOutputTokens: number;
  implementerReasoningTokens: number | undefined;
  escalationReasoningTokens: number | undefined;
  implementerCacheReadTokens: number;
  implementerCacheCreateTokens: number;
  escalationCacheReadTokens: number;
  escalationCacheCreateTokens: number;
};

function tokenDelta(before: TokenUsage, after: TokenUsage): TaskUsageDelta {
  const implementerInputTokens = after.implementerInput - before.implementerInput;
  const implementerOutputTokens = after.implementerOutput - before.implementerOutput;
  const escalationInputTokens = after.escalationInput - before.escalationInput;
  const escalationOutputTokens = after.escalationOutput - before.escalationOutput;
  return {
    implementerTokens: implementerInputTokens + implementerOutputTokens,
    escalationTokens: escalationInputTokens + escalationOutputTokens,
    implementerInputTokens,
    implementerOutputTokens,
    escalationInputTokens,
    escalationOutputTokens,
    implementerReasoningTokens: knownDelta(before.implementerReasoning, after.implementerReasoning),
    escalationReasoningTokens: knownDelta(before.escalationReasoning, after.escalationReasoning),
    implementerCacheReadTokens: clampNonNegative(
      (after.implementerCacheRead ?? 0) - (before.implementerCacheRead ?? 0),
    ),
    implementerCacheCreateTokens: clampNonNegative(
      (after.implementerCacheCreate ?? 0) - (before.implementerCacheCreate ?? 0),
    ),
    escalationCacheReadTokens: clampNonNegative(
      (after.escalationCacheRead ?? 0) - (before.escalationCacheRead ?? 0),
    ),
    escalationCacheCreateTokens: clampNonNegative(
      (after.escalationCacheCreate ?? 0) - (before.escalationCacheCreate ?? 0),
    ),
  };
}

function emitTaskTokens(
  bus: EventBus,
  state: WorkflowState,
  id: TaskId,
  usage: TaskTokenUsage,
): void {
  bus.publish({
    type: 'task_tokens',
    ts: Date.now(),
    phase: state.phase,
    taskId: id,
    method: usage.method,
    implementerTokens: usage.implementerTokens,
    escalationTokens: usage.escalationTokens,
    retryCount: usage.retryCount,
    ...definedTaskUsageFields(usage, TASK_USAGE_ATTEMPT_KEYS),
  });
}

type RecordTaskUsageOptions = {
  task: Task;
  method: TaskTokenUsage['method'];
  tokensBefore: TokenUsage;
  currentUsage: TokenUsage;
  bus: EventBus;
  state: WorkflowState;
  taskBreakdowns: TaskTokenUsage[];
  retryCount?: number;
  tool?: string;
  model?: string;
  implementerProfile?: string;
  routingDecision?: RoutingDecision;
};

export function recordTaskUsage(opts: RecordTaskUsageOptions): void {
  const {
    task,
    method,
    tokensBefore,
    currentUsage,
    bus,
    state,
    taskBreakdowns,
    retryCount,
    tool,
    model,
    implementerProfile,
    routingDecision,
  } = opts;
  const delta = tokenDelta(tokensBefore, currentUsage);
  const hasImplementerUsage =
    delta.implementerTokens > 0 ||
    (delta.implementerReasoningTokens ?? 0) > 0 ||
    delta.implementerCacheReadTokens > 0 ||
    delta.implementerCacheCreateTokens > 0;
  const hasEscalationUsage =
    delta.escalationTokens > 0 ||
    (delta.escalationReasoningTokens ?? 0) > 0 ||
    delta.escalationCacheReadTokens > 0 ||
    delta.escalationCacheCreateTokens > 0;
  if (!hasImplementerUsage && !hasEscalationUsage) {
    publishWarning({
      bus,
      phase: state.phase,
      taskId: task.id,
      message: `${tool ?? 'implementer'} completed task ${task.id} without reporting token usage; the run records zero implementer tokens for it.`,
      safety: { category: 'usage', code: 'implementer_usage_not_reported' },
    });
  }
  const usage: TaskTokenUsage = {
    taskId: task.id,
    taskTitle: task.title,
    method,
    implementerTokens: delta.implementerTokens,
    escalationTokens: delta.escalationTokens,
    ...(hasImplementerUsage && {
      implementerCacheReadTokens: delta.implementerCacheReadTokens,
      implementerCacheCreateTokens: delta.implementerCacheCreateTokens,
      implementerInputTokens: delta.implementerInputTokens,
      implementerOutputTokens: delta.implementerOutputTokens,
      ...(delta.implementerReasoningTokens !== undefined && {
        implementerReasoningTokens: delta.implementerReasoningTokens,
      }),
    }),
    ...(hasEscalationUsage && {
      escalationCacheReadTokens: delta.escalationCacheReadTokens,
      escalationCacheCreateTokens: delta.escalationCacheCreateTokens,
      escalationInputTokens: delta.escalationInputTokens,
      escalationOutputTokens: delta.escalationOutputTokens,
      ...(delta.escalationReasoningTokens !== undefined && {
        escalationReasoningTokens: delta.escalationReasoningTokens,
      }),
    }),
    retryCount: retryCount ?? 0,
    ...(tool !== undefined && { tool }),
    ...(model !== undefined && { model }),
    ...(implementerProfile !== undefined && { implementerProfile }),
    ...(routingDecision !== undefined && {
      contextFit: routingDecision.fit,
      estimatedTokens: routingDecision.estimatedTokens,
      untruncatedEstimatedTokens: routingDecision.untruncatedEstimatedTokens,
      ...(routingDecision.contextLength !== undefined && {
        contextLength: routingDecision.contextLength,
      }),
      currentCodeTruncated: routingDecision.currentCodeTruncated,
      currentCodeContextMode: routingDecision.currentCodeContextMode,
      routingReason: routingDecision.reason,
    }),
  };
  taskBreakdowns.push(usage);
  emitTaskTokens(bus, state, task.id, usage);
}
