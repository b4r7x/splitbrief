import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';
import { resolvePricing, type ResolvedPricing } from '../pricing-resolver.js';
import type { ModelCacheAccessor } from '../model/resolution.js';
import {
  allocatedCacheTokens,
  buildProviderUsageSegment,
  calculateCacheReadSavings,
  recordPricedUsage,
  recordProviderCost,
  resolveTaskPricingModel,
  splitTokens,
  type ProviderCostEntry,
  type ProviderUsageSegment,
} from '../cost-math.js';

type CostBreakdownOptions = {
  tokenUsage: TokenUsage;
  totalTasks: number;
  escalatedCount: number;
  completedLocalTasks?: number | undefined;
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
  taskBreakdowns?: TaskTokenUsage[] | undefined;
};

type ImplementerCostAccounting = {
  actualImplementerCost: number;
  hasPricedUsage: boolean;
  hasUnpricedUsage: boolean;
  providerCosts: Record<string, ProviderCostEntry>;
  cacheReadSavings: number;
};

function applyImplementerUsageSegment(
  accounting: ImplementerCostAccounting,
  segment: ProviderUsageSegment,
): void {
  if (segment.usageTokens <= 0) return;
  accounting.actualImplementerCost += segment.cost;
  accounting.cacheReadSavings += calculateCacheReadSavings(
    segment.cacheReadTokens,
    segment.pricing,
    segment.contextTokens,
  );
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

function calculateAggregateImplementerCost(
  opts: CostBreakdownOptions,
  pricing: ResolvedPricing,
): ImplementerCostAccounting {
  const { tokenUsage, implementerTool } = opts;
  const accounting: ImplementerCostAccounting = {
    actualImplementerCost: 0,
    hasPricedUsage: false,
    hasUnpricedUsage: false,
    providerCosts: {},
    cacheReadSavings: 0,
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

function calculateTaskAwareImplementerCost(
  opts: CostBreakdownOptions,
  cache?: ModelCacheAccessor,
): ImplementerCostAccounting | undefined {
  const { taskBreakdowns, tokenUsage, implementerTool, implementerModel } = opts;
  if (taskBreakdowns === undefined) return undefined;

  const totalImplementerTokens = tokenUsage.implementerInput + tokenUsage.implementerOutput;
  const accounting: ImplementerCostAccounting = {
    actualImplementerCost: 0,
    hasPricedUsage: false,
    hasUnpricedUsage: false,
    providerCosts: {},
    cacheReadSavings: 0,
  };
  let accountedTokens = 0;
  let accountedCacheReadTokens = 0;
  let accountedCacheCreateTokens = 0;

  for (const task of taskBreakdowns) {
    const tool = task.tool ?? implementerTool;
    const { inputTokens, outputTokens } = splitTokens({
      tokens: task.implementerTokens,
      inputTotal: tokenUsage.implementerInput,
      outputTotal: tokenUsage.implementerOutput,
    });
    const cacheReadTokens =
      task.implementerCacheReadTokens ??
      allocatedCacheTokens({
        cacheTokens: tokenUsage.implementerCacheRead,
        tokens: task.implementerTokens,
        totalTokens: totalImplementerTokens,
      });
    const cacheCreateTokens =
      task.implementerCacheCreateTokens ??
      allocatedCacheTokens({
        cacheTokens: tokenUsage.implementerCacheCreate,
        tokens: task.implementerTokens,
        totalTokens: totalImplementerTokens,
      });
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
        outputTokens,
        cacheReadTokens,
        cacheCreateTokens,
      },
      cache,
    );
    accountedTokens += task.implementerTokens;
    accountedCacheReadTokens += cacheReadTokens;
    accountedCacheCreateTokens += cacheCreateTokens;
  }

  const residualTokens = Math.max(0, totalImplementerTokens - accountedTokens);
  const residualCacheReadTokens = Math.max(
    0,
    (tokenUsage.implementerCacheRead ?? 0) - accountedCacheReadTokens,
  );
  const residualCacheCreateTokens = Math.max(
    0,
    (tokenUsage.implementerCacheCreate ?? 0) - accountedCacheCreateTokens,
  );
  if (residualTokens > 0 || residualCacheReadTokens > 0 || residualCacheCreateTokens > 0) {
    const { inputTokens, outputTokens } = splitTokens({
      tokens: residualTokens,
      inputTotal: tokenUsage.implementerInput,
      outputTotal: tokenUsage.implementerOutput,
    });
    applyImplementerUsageCost(
      accounting,
      {
        tool: implementerTool,
        model: implementerModel,
        inputTokens,
        outputTokens,
        cacheReadTokens: residualCacheReadTokens,
        cacheCreateTokens: residualCacheCreateTokens,
      },
      cache,
    );
  }

  return accounting;
}

export function calculateCostBreakdown(
  opts: CostBreakdownOptions,
  cache?: ModelCacheAccessor,
): CostBreakdown {
  const { tokenUsage, totalTasks, escalatedCount, completedLocalTasks, plannerTool, plannerModel } =
    opts;
  const plannerPricing = resolvePricing(plannerTool, cache, plannerModel);
  const implementerPricing = resolvePricing(opts.implementerTool, cache, opts.implementerModel);

  const plannerInputTotal = tokenUsage.plannerInput + tokenUsage.escalationInput;
  const plannerOutputTotal = tokenUsage.plannerOutput + tokenUsage.escalationOutput;

  const plannerSegment = buildProviderUsageSegment({
    tool: plannerTool,
    model: plannerModel,
    inputTokens: plannerInputTotal,
    outputTokens: plannerOutputTotal,
    cacheReadTokens: tokenUsage.plannerCacheRead ?? 0,
    cacheCreateTokens: tokenUsage.plannerCacheCreate ?? 0,
    pricing: plannerPricing,
  });
  const actualPlannerCost = plannerSegment.cost;

  const implementerAccounting =
    calculateTaskAwareImplementerCost(opts, cache) ??
    calculateAggregateImplementerCost(opts, implementerPricing);
  const actualImplementerCost = implementerAccounting.actualImplementerCost;

  const totalActualCost = actualPlannerCost + actualImplementerCost;
  const plannerUsageTokens =
    plannerInputTotal +
    plannerOutputTotal +
    (tokenUsage.plannerCacheRead ?? 0) +
    (tokenUsage.plannerCacheCreate ?? 0);
  const implementerUsageTokens =
    tokenUsage.implementerInput +
    tokenUsage.implementerOutput +
    (tokenUsage.implementerCacheRead ?? 0) +
    (tokenUsage.implementerCacheCreate ?? 0);
  const isActualPlannerCostKnown = plannerUsageTokens <= 0 || plannerSegment.costKnown;
  const isActualImplementerCostKnown =
    implementerUsageTokens <= 0 || !implementerAccounting.hasUnpricedUsage;
  const isTotalActualCostKnown = isActualPlannerCostKnown && isActualImplementerCostKnown;
  const hypotheticalImplementerSegment = buildProviderUsageSegment({
    tool: plannerTool,
    model: plannerModel,
    inputTokens: tokenUsage.implementerInput,
    outputTokens: tokenUsage.implementerOutput,
    cacheReadTokens: tokenUsage.implementerCacheRead ?? 0,
    cacheCreateTokens: tokenUsage.implementerCacheCreate ?? 0,
    pricing: plannerPricing,
  });
  const hypotheticalImplementerCost = hypotheticalImplementerSegment.cost;
  const isHypotheticalImplementerCostKnown =
    implementerUsageTokens <= 0 || hypotheticalImplementerSegment.costKnown;
  const isAllPlannerBaselineKnown = isActualPlannerCostKnown && isHypotheticalImplementerCostKnown;
  const hypotheticalCost = isAllPlannerBaselineKnown
    ? actualPlannerCost + hypotheticalImplementerCost
    : 0;
  const hasSavingsEstimate = isAllPlannerBaselineKnown && isTotalActualCostKnown;
  const savingsAmount = hasSavingsEstimate ? hypotheticalCost - totalActualCost : 0;
  const savingsPercentage =
    hasSavingsEstimate && hypotheticalCost > 0 ? (savingsAmount / hypotheticalCost) * 100 : 0;
  const localSuccesses = completedLocalTasks ?? Math.max(0, totalTasks - escalatedCount);
  const localCompletionRate = totalTasks > 0 ? localSuccesses / totalTasks : 0;
  const hasPricedUsage =
    (plannerSegment.usageTokens > 0 && plannerPricing.isPriced) ||
    implementerAccounting.hasPricedUsage;
  const hasUnpricedUsage =
    (plannerSegment.usageTokens > 0 && !plannerSegment.costKnown) ||
    implementerAccounting.hasUnpricedUsage;

  const providerCosts: Record<string, ProviderCostEntry> = {};
  recordPricedUsage(providerCosts, plannerSegment);
  for (const [tool, entry] of Object.entries(implementerAccounting.providerCosts)) {
    recordProviderCost(providerCosts, {
      tool,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheCreateTokens: entry.cacheCreateTokens,
      cost: entry.cost,
    });
  }

  const cacheReadTokens =
    (tokenUsage.plannerCacheRead ?? 0) + (tokenUsage.implementerCacheRead ?? 0);
  const cacheWriteTokens =
    (tokenUsage.plannerCacheCreate ?? 0) + (tokenUsage.implementerCacheCreate ?? 0);

  let cacheReadSavings = 0;
  if (cacheReadTokens > 0) {
    cacheReadSavings += calculateCacheReadSavings(
      tokenUsage.plannerCacheRead ?? 0,
      plannerPricing,
      plannerSegment.contextTokens,
    );
    cacheReadSavings += implementerAccounting.cacheReadSavings;
  }

  return {
    hypotheticalCost,
    actualPlannerCost,
    actualImplementerCost,
    totalActualCost,
    savingsAmount,
    savingsPercentage,
    localCompletionRate,
    hasPricedUsage,
    hasUnpricedUsage,
    hasSavingsEstimate,
    isActualPlannerCostKnown,
    isActualImplementerCostKnown,
    isTotalActualCostKnown,
    isAllPlannerBaselineKnown,
    providerCosts: Object.keys(providerCosts).length > 0 ? providerCosts : undefined,
    ...(cacheReadSavings > 0 && { cacheReadSavings }),
    ...(cacheReadTokens > 0 && { cacheReadTokens }),
    ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
  };
}
