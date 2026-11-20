import type { TaskId, Task } from '../../../core/schemas/task.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import {
  type TokenUsage,
  type TaskTokenUsage,
  definedTaskUsageFields,
  TASK_USAGE_ATTEMPT_KEYS,
} from '../../../core/schemas/tokens.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { EventBus } from '../../events/types.js';
import type { RoutingDecision } from '../context-routing/types.js';
import type { WorkflowContext } from '../types.js';
import { publishWarning } from '../publish/notice.js';

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
  kind?: TaskTokenUsage['kind'];
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
    kind,
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
  if (method !== 'skipped' && !hasImplementerUsage && !hasEscalationUsage) {
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
    ...(kind !== undefined && { kind }),
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

export function recordSettledTaskUsage(
  opts: Pick<
    RecordTaskUsageOptions,
    'state' | 'task' | 'method' | 'tokensBefore' | 'taskBreakdowns' | 'retryCount'
  > & {
    wctx: Pick<WorkflowContext, 'config' | 'bus' | 'implementerProfile' | 'routingDecision'>;
    tool?: string | undefined;
    model?: string | undefined;
  },
): void {
  const { wctx, state, tool, model, ...settlement } = opts;
  const runner = wctx.config.implementer;
  const selectedModel = model ?? runner.model;
  recordTaskUsage({
    ...settlement,
    state,
    bus: wctx.bus,
    currentUsage: state.tokenUsage,
    tool: tool ?? getRunnerDisplayName(runner),
    kind: runner.kind,
    ...(selectedModel !== undefined && { model: selectedModel }),
    ...(wctx.implementerProfile !== undefined && { implementerProfile: wctx.implementerProfile }),
    ...(wctx.routingDecision !== undefined && { routingDecision: wctx.routingDecision }),
  });
}
