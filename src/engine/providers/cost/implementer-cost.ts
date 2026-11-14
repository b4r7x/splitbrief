import type { ModelCacheAccessor } from '../model/runtime-snapshot.js';
import type { CostBreakdownOptions } from './types.js';
import {
  type ProviderCostEntry,
  type ProviderUsageSegment,
  recordPricedUsage,
  buildProviderUsageSegment,
  resolveTaskPricingModel,
} from './math.js';
import { resolvePricing, type ResolvedPricing } from './pricing.js';

type ImplementerCostAccounting = {
  actualImplementerCost: number;
  hasPricedUsage: boolean;
  hasUnpricedUsage: boolean;
  providerCosts: Record<string, ProviderCostEntry>;
};

function applyImplementerUsageSegment(
  accounting: ImplementerCostAccounting,
  segment: ProviderUsageSegment,
): void {
  if (segment.usageTokens <= 0) return;
  accounting.actualImplementerCost += segment.cost;
  if (segment.pricing.isPriced) {
    accounting.hasPricedUsage = true;
  }
  if (!segment.costKnown) {
    accounting.hasUnpricedUsage = true;
  }
  recordPricedUsage(accounting.providerCosts, segment);
}

function applyImplementerUsageCost(
  accounting: ImplementerCostAccounting,
  opts: {
    tool: string;
    model?: string | undefined;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  },
  cache?: ModelCacheAccessor,
): void {
  const pricing = resolvePricing(opts.tool, cache, opts.model);
  applyImplementerUsageSegment(
    accounting,
    buildProviderUsageSegment({
      tool: opts.tool,
      model: opts.model,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      cacheReadTokens: opts.cacheReadTokens,
      cacheCreateTokens: opts.cacheCreateTokens,
      pricing,
    }),
  );
}

export function calculateAggregateImplementerCost(
  opts: CostBreakdownOptions,
  pricing: ResolvedPricing,
): ImplementerCostAccounting {
  const { tokenUsage, implementerTool } = opts;
  const accounting: ImplementerCostAccounting = {
    actualImplementerCost: 0,
    hasPricedUsage: false,
    hasUnpricedUsage: false,
    providerCosts: {},
  };
  applyImplementerUsageSegment(
    accounting,
    buildProviderUsageSegment({
      tool: implementerTool,
      model: opts.implementerModel,
      inputTokens: tokenUsage.implementerInput,
      outputTokens: tokenUsage.implementerOutput,
      cacheReadTokens: tokenUsage.implementerCacheRead ?? 0,
      cacheCreateTokens: tokenUsage.implementerCacheCreate ?? 0,
      pricing,
    }),
  );
  return accounting;
}

/**
 * Books each task's implementer spend against the provider that served it, from
 * the directional counters the task actually recorded. A record that carries a
 * combined count alone cannot say how much of it was input, so it is left
 * unattributed — its tokens stay with the run's own seat below and the run
 * reports an unpriced part rather than a share it never observed.
 */
export function calculateTaskAwareImplementerCost(
  opts: CostBreakdownOptions,
  cache?: ModelCacheAccessor,
): ImplementerCostAccounting | undefined {
  const { taskBreakdowns, tokenUsage, implementerTool, implementerModel } = opts;
  if (taskBreakdowns === undefined) return undefined;

  const accounting: ImplementerCostAccounting = {
    actualImplementerCost: 0,
    hasPricedUsage: false,
    hasUnpricedUsage: false,
    providerCosts: {},
  };
  let accountedInputTokens = 0;
  let accountedOutputTokens = 0;
  let accountedCacheReadTokens = 0;
  let accountedCacheCreateTokens = 0;

  for (const task of taskBreakdowns) {
    const hasDirectionalSplit =
      task.implementerInputTokens !== undefined && task.implementerOutputTokens !== undefined;
    if (!hasDirectionalSplit && task.implementerTokens > 0) {
      accounting.hasUnpricedUsage = true;
      continue;
    }
    const tool = task.tool ?? implementerTool;
    const inputTokens = task.implementerInputTokens ?? 0;
    const cacheReadTokens = task.implementerCacheReadTokens ?? 0;
    const cacheCreateTokens = task.implementerCacheCreateTokens ?? 0;
    const generatedTokens =
      (task.implementerOutputTokens ?? 0) + (task.implementerReasoningTokens ?? 0);
    applyImplementerUsageCost(
      accounting,
      {
        tool,
        model: resolveTaskPricingModel({
          taskTool: tool,
          fallbackTool: implementerTool,
          taskModel: task.model,
          fallbackModel: implementerModel,
        }),
        inputTokens,
        outputTokens: generatedTokens,
        cacheReadTokens,
        cacheCreateTokens,
      },
      cache,
    );
    accountedInputTokens += inputTokens;
    accountedOutputTokens += generatedTokens;
    accountedCacheReadTokens += cacheReadTokens;
    accountedCacheCreateTokens += cacheCreateTokens;
  }

  // What no task claimed is what the run's own seat spent: an exact remainder,
  // not a ratio.
  const residualInputTokens = Math.max(0, tokenUsage.implementerInput - accountedInputTokens);
  const residualOutputTokens = Math.max(0, tokenUsage.implementerOutput - accountedOutputTokens);
  const residualCacheReadTokens = Math.max(
    0,
    (tokenUsage.implementerCacheRead ?? 0) - accountedCacheReadTokens,
  );
  const residualCacheCreateTokens = Math.max(
    0,
    (tokenUsage.implementerCacheCreate ?? 0) - accountedCacheCreateTokens,
  );
  if (
    residualInputTokens > 0 ||
    residualOutputTokens > 0 ||
    residualCacheReadTokens > 0 ||
    residualCacheCreateTokens > 0
  ) {
    applyImplementerUsageCost(
      accounting,
      {
        tool: implementerTool,
        model: implementerModel,
        inputTokens: residualInputTokens,
        outputTokens: residualOutputTokens,
        cacheReadTokens: residualCacheReadTokens,
        cacheCreateTokens: residualCacheCreateTokens,
      },
      cache,
    );
  }

  return accounting;
}
