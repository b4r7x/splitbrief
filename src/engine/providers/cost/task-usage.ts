import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { CallUsageEvidence } from '../../../core/schemas/usage-evidence.js';
import { resolvePricing } from '../pricing-resolver.js';
import type { ModelCacheAccessor } from '../model/resolution.js';
import { buildProviderUsageSegment, resolveTaskPricingModel } from '../cost-math.js';
import { resolveCallPricing, sumRequestEstimates } from './request-estimates.js';

export interface CalculateTaskUsageCostOptions {
  task: TaskTokenUsage;
  implementerTool: string;
  plannerTool: string;
  implementerModel?: string | undefined;
  plannerModel?: string | undefined;
  cache?: ModelCacheAccessor | undefined;
  /**
   * The run's per-call usage records. Where a call named this task, its own
   * requests are what the task spent — each priced against the runner and model
   * that served it, so a retry on another model keeps its own identity instead
   * of inheriting the seat's.
   */
  callEvidence?: readonly CallUsageEvidence[] | undefined;
}

/** What one leg of a task cost, and whether that figure is the whole of it. */
type TaskUsageLeg = { cost: number; known: boolean };

type RecordedLeg = {
  tokens: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheCreateTokens?: number | undefined;
  tool: string;
  model?: string | undefined;
};

function priceRecordedLeg(leg: RecordedLeg, cache: ModelCacheAccessor | undefined): TaskUsageLeg {
  const cacheReadTokens = leg.cacheReadTokens ?? 0;
  const cacheCreateTokens = leg.cacheCreateTokens ?? 0;
  const hasDirectionalSplit = leg.inputTokens !== undefined && leg.outputTokens !== undefined;
  // A combined count whose direction was never recorded cannot be priced, and
  // an unknown split is not a zero one.
  if (!hasDirectionalSplit && leg.tokens > 0) return { cost: 0, known: false };

  const segment = buildProviderUsageSegment({
    tool: leg.tool,
    model: leg.model,
    inputTokens: leg.inputTokens ?? 0,
    // One output rate covers the whole generation, so the reasoning the provider
    // reported is priced beside ordinary output — and a seat that reported none
    // adds nothing rather than an invented zero.
    outputTokens: (leg.outputTokens ?? 0) + (leg.reasoningTokens ?? 0),
    cacheReadTokens,
    cacheCreateTokens,
    pricing: resolvePricing(leg.tool, cache, leg.model),
  });
  return {
    cost: segment.cost,
    known: segment.usageTokens <= 0 || segment.costKnown,
  };
}

function priceRecordedCalls(
  options: CalculateTaskUsageCostOptions,
  role: CallUsageEvidence['role'],
): TaskUsageLeg | undefined {
  const calls = options.callEvidence?.filter(
    (call) => call.taskId === options.task.taskId && call.role === role,
  );
  if (calls === undefined) return undefined;
  if (calls.length === 0) {
    const tokens =
      role === 'implementer' ? options.task.implementerTokens : options.task.escalationTokens;
    return { cost: 0, known: tokens === 0 };
  }
  const estimate = sumRequestEstimates(calls, (call) => resolveCallPricing(call, options.cache));
  return { cost: estimate.knownSubtotal, known: estimate.completeness === 'complete' };
}

function buildTaskImplementerSegment(options: CalculateTaskUsageCostOptions): TaskUsageLeg {
  const { task, implementerTool, implementerModel, cache } = options;
  const tool = task.tool ?? implementerTool;
  const model = resolveTaskPricingModel({
    taskTool: tool,
    fallbackTool: implementerTool,
    taskModel: task.model,
    fallbackModel: implementerModel,
  });
  return (
    priceRecordedCalls(options, 'implementer') ??
    priceRecordedLeg(
      {
        tokens: task.implementerTokens,
        inputTokens: task.implementerInputTokens,
        outputTokens: task.implementerOutputTokens,
        reasoningTokens: task.implementerReasoningTokens,
        cacheReadTokens: task.implementerCacheReadTokens,
        cacheCreateTokens: task.implementerCacheCreateTokens,
        tool,
        model,
      },
      cache,
    )
  );
}

function buildTaskEscalationSegment(options: CalculateTaskUsageCostOptions): TaskUsageLeg {
  const { task, plannerTool, plannerModel, cache } = options;
  return (
    priceRecordedCalls(options, 'escalation') ??
    priceRecordedLeg(
      {
        tokens: task.escalationTokens,
        inputTokens: task.escalationInputTokens,
        outputTokens: task.escalationOutputTokens,
        reasoningTokens: task.escalationReasoningTokens,
        cacheReadTokens: task.escalationCacheReadTokens,
        cacheCreateTokens: task.escalationCacheCreateTokens,
        tool: plannerTool,
        model: plannerModel,
      },
      cache,
    )
  );
}

export function calculateTaskUsageCost(options: CalculateTaskUsageCostOptions): number {
  return buildTaskImplementerSegment(options).cost + buildTaskEscalationSegment(options).cost;
}

export function isTaskUsageCostKnown(options: CalculateTaskUsageCostOptions): boolean {
  return buildTaskImplementerSegment(options).known && buildTaskEscalationSegment(options).known;
}
