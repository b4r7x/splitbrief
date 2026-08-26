import { assertNever } from '../../utils/type-guards.js';
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
type CacheTokenKey = Extract<
  keyof TokenUsage,
  `${'planner' | 'implementer' | 'reviewer'}${'CacheRead' | 'CacheCreate'}`
>;

// escalation cache tokens are routed into the planner cache buckets because the escalator
// always uses the planner runner; this preserves cache savings without adding new schema fields.
const categoryFields: Record<
  UsageCategory,
  {
    input: CoreTokenKey;
    output: CoreTokenKey;
    cacheRead?: CacheTokenKey;
    cacheCreate?: CacheTokenKey;
  }
> = {
  planner: {
    input: 'plannerInput',
    output: 'plannerOutput',
    cacheRead: 'plannerCacheRead',
    cacheCreate: 'plannerCacheCreate',
  },
  implementer: {
    input: 'implementerInput',
    output: 'implementerOutput',
    cacheRead: 'implementerCacheRead',
    cacheCreate: 'implementerCacheCreate',
  },
  escalation: {
    input: 'escalationInput',
    output: 'escalationOutput',
    cacheRead: 'plannerCacheRead',
    cacheCreate: 'plannerCacheCreate',
  },
  reviewer: {
    input: 'reviewerInput',
    output: 'reviewerOutput',
    cacheRead: 'reviewerCacheRead',
    cacheCreate: 'reviewerCacheCreate',
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

export function addRunnerCallUsageToTokenUsage(
  totals: TokenUsage,
  role: RunnerCallRole,
  usage: RunnerCallUsage,
): void {
  const fields = categoryFields[usageCategoryForRunnerCallRole(role)];
  totals[fields.input] += usage.inputTokens;
  totals[fields.output] += usage.outputTokens;
  if (fields.cacheRead !== undefined && usage.cacheReadTokens !== undefined) {
    totals[fields.cacheRead] = (totals[fields.cacheRead] ?? 0) + usage.cacheReadTokens;
  }
  if (fields.cacheCreate !== undefined && usage.cacheCreateTokens !== undefined) {
    totals[fields.cacheCreate] = (totals[fields.cacheCreate] ?? 0) + usage.cacheCreateTokens;
  }
}

export function addUsage(
  state: WorkflowState,
  category: UsageCategory,
  usage: TokenDelta | null | undefined,
): WorkflowState {
  if (!usage) return state;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const fields = categoryFields[category];
  const nextUsage = {
    ...state.tokenUsage,
    [fields.input]: state.tokenUsage[fields.input] + input,
    [fields.output]: state.tokenUsage[fields.output] + output,
  };
  if (fields.cacheRead !== undefined && usage.cacheReadTokens !== undefined) {
    nextUsage[fields.cacheRead] = (state.tokenUsage[fields.cacheRead] ?? 0) + usage.cacheReadTokens;
  }
  if (fields.cacheCreate !== undefined && usage.cacheCreateTokens !== undefined) {
    nextUsage[fields.cacheCreate] =
      (state.tokenUsage[fields.cacheCreate] ?? 0) + usage.cacheCreateTokens;
  }
  return {
    ...state,
    tokenUsage: nextUsage,
  };
}

function clampNonNegative(value: number): number {
  return Math.max(0, value);
}

function tokenDelta(
  before: TokenUsage,
  after: TokenUsage,
): {
  implementerTokens: number;
  escalationTokens: number;
  implementerCacheReadTokens: number;
  implementerCacheCreateTokens: number;
  escalationCacheReadTokens: number;
  escalationCacheCreateTokens: number;
} {
  const implementerBefore = before.implementerInput + before.implementerOutput;
  const implementerAfter = after.implementerInput + after.implementerOutput;
  const escalationBefore = before.escalationInput + before.escalationOutput;
  const escalationAfter = after.escalationInput + after.escalationOutput;
  return {
    implementerTokens: implementerAfter - implementerBefore,
    escalationTokens: escalationAfter - escalationBefore,
    implementerCacheReadTokens: clampNonNegative(
      (after.implementerCacheRead ?? 0) - (before.implementerCacheRead ?? 0),
    ),
    implementerCacheCreateTokens: clampNonNegative(
      (after.implementerCacheCreate ?? 0) - (before.implementerCacheCreate ?? 0),
    ),
    escalationCacheReadTokens: clampNonNegative(
      (after.plannerCacheRead ?? 0) - (before.plannerCacheRead ?? 0),
    ),
    escalationCacheCreateTokens: clampNonNegative(
      (after.plannerCacheCreate ?? 0) - (before.plannerCacheCreate ?? 0),
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
    delta.implementerCacheReadTokens > 0 ||
    delta.implementerCacheCreateTokens > 0;
  const hasEscalationUsage =
    delta.escalationTokens > 0 ||
    delta.escalationCacheReadTokens > 0 ||
    delta.escalationCacheCreateTokens > 0;
  if (!hasImplementerUsage && !hasEscalationUsage) {
    publishWarning({
      bus,
      phase: state.phase,
      taskId: task.id,
      message: `${tool ?? 'implementer'} completed task ${task.id} without reporting token usage; the run records zero implementer tokens for it.`,
      safety: { category: 'cost', code: 'implementer_usage_not_reported', transcriptSafe: true },
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
    }),
    ...(hasEscalationUsage && {
      escalationCacheReadTokens: delta.escalationCacheReadTokens,
      escalationCacheCreateTokens: delta.escalationCacheCreateTokens,
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
      costPosture: routingDecision.costPosture,
      routingReason: routingDecision.reason,
    }),
  };
  taskBreakdowns.push(usage);
  emitTaskTokens(bus, state, task.id, usage);
}
