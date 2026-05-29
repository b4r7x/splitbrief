import type { TaskTokenUsage, TokenUsage } from '../../core/schemas/tokens.js';
import type { CostBreakdown } from '../../core/schemas/summary.js';
import { resolvePricing, type ResolvedPricing } from './pricing-resolver.js';
import type { ModelCacheAccessor } from './model/resolution.js';
import {
  allocatedCacheTokens,
  calculateCacheReadSavings,
  calculateCost,
  calculateUsageCost,
  recordPricedUsage,
  recordProviderCost,
  resolveTaskPricingModel,
  splitTokens,
  type ProviderCostEntry,
} from './cost-math.js';

type CostBreakdownOptions = {
  tokenUsage: TokenUsage;
  totalTasks: number;
  escalatedCount: number;
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
  const cost = calculateUsageCost({
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    cacheReadTokens: opts.cacheReadTokens,
    cacheCreateTokens: opts.cacheCreateTokens,
    pricing,
  });

  accounting.actualImplementerCost += cost;
  accounting.cacheReadSavings += calculateCacheReadSavings(opts.cacheReadTokens, pricing);
  if (pricing.isPriced) {
    accounting.hasPricedUsage = true;
  } else {
    accounting.hasUnpricedUsage = true;
  }
  recordPricedUsage(accounting.providerCosts, {
    tool: opts.tool,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    cost,
    pricing,
  });
}

function calculateAggregateImplementerCost(
  opts: CostBreakdownOptions,
  pricing: ResolvedPricing,
): ImplementerCostAccounting {
  const { tokenUsage, implementerTool } = opts;
  const actualImplementerCost = calculateUsageCost({
    inputTokens: tokenUsage.implementerInput,
    outputTokens: tokenUsage.implementerOutput,
    cacheReadTokens: tokenUsage.implementerCacheRead ?? 0,
    cacheCreateTokens: tokenUsage.implementerCacheCreate ?? 0,
    pricing,
  });
  const providerCosts: Record<string, ProviderCostEntry> = {};
  recordPricedUsage(providerCosts, {
    tool: implementerTool,
    inputTokens: tokenUsage.implementerInput,
    outputTokens: tokenUsage.implementerOutput,
    cost: actualImplementerCost,
    pricing,
  });

  return {
    actualImplementerCost,
    hasPricedUsage: pricing.isPriced,
    hasUnpricedUsage: !pricing.isPriced,
    providerCosts,
    cacheReadSavings: calculateCacheReadSavings(tokenUsage.implementerCacheRead ?? 0, pricing),
  };
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

  for (const task of taskBreakdowns) {
    if (task.implementerTokens <= 0) continue;
    const tool = task.tool ?? implementerTool;
    const { inputTokens, outputTokens } = splitTokens(
      task.implementerTokens,
      tokenUsage.implementerInput,
      tokenUsage.implementerOutput,
    );
    applyImplementerUsageCost(
      accounting,
      {
        tool,
        model: resolveTaskPricingModel(tool, implementerTool, task.model, implementerModel),
        inputTokens,
        outputTokens,
        cacheReadTokens: allocatedCacheTokens(
          tokenUsage.implementerCacheRead,
          task.implementerTokens,
          totalImplementerTokens,
        ),
        cacheCreateTokens: allocatedCacheTokens(
          tokenUsage.implementerCacheCreate,
          task.implementerTokens,
          totalImplementerTokens,
        ),
      },
      cache,
    );
    accountedTokens += task.implementerTokens;
  }

  const residualTokens = Math.max(0, totalImplementerTokens - accountedTokens);
  if (residualTokens > 0) {
    const { inputTokens, outputTokens } = splitTokens(
      residualTokens,
      tokenUsage.implementerInput,
      tokenUsage.implementerOutput,
    );
    applyImplementerUsageCost(
      accounting,
      {
        tool: implementerTool,
        model: implementerModel,
        inputTokens,
        outputTokens,
        cacheReadTokens: allocatedCacheTokens(
          tokenUsage.implementerCacheRead,
          residualTokens,
          totalImplementerTokens,
        ),
        cacheCreateTokens: allocatedCacheTokens(
          tokenUsage.implementerCacheCreate,
          residualTokens,
          totalImplementerTokens,
        ),
      },
      cache,
    );
  }

  return accounting;
}

export type TaskCostTokenUsage = Pick<
  TokenUsage,
  | 'implementerInput'
  | 'implementerOutput'
  | 'escalationInput'
  | 'escalationOutput'
  | 'implementerCacheRead'
  | 'implementerCacheCreate'
>;

export interface CalculateTaskUsageCostOptions {
  task: TaskTokenUsage;
  tokenUsage: TaskCostTokenUsage;
  implementerTool: string;
  plannerTool: string;
  implementerModel?: string | undefined;
  plannerModel?: string | undefined;
  cache?: ModelCacheAccessor | undefined;
}

export function calculateTaskUsageCost(options: CalculateTaskUsageCostOptions): number {
  const { task, tokenUsage, implementerTool, plannerTool, implementerModel, plannerModel, cache } =
    options;
  const totalImplementerTokens = tokenUsage.implementerInput + tokenUsage.implementerOutput;
  const implementerSplit = splitTokens(
    task.implementerTokens,
    tokenUsage.implementerInput,
    tokenUsage.implementerOutput,
  );
  const taskTool = task.tool ?? implementerTool;
  const implementerPricing = resolvePricing(
    taskTool,
    cache,
    resolveTaskPricingModel(taskTool, implementerTool, task.model, implementerModel),
  );
  const implementerCost = calculateUsageCost({
    inputTokens: implementerSplit.inputTokens,
    outputTokens: implementerSplit.outputTokens,
    cacheReadTokens: allocatedCacheTokens(
      tokenUsage.implementerCacheRead,
      task.implementerTokens,
      totalImplementerTokens,
    ),
    cacheCreateTokens: allocatedCacheTokens(
      tokenUsage.implementerCacheCreate,
      task.implementerTokens,
      totalImplementerTokens,
    ),
    pricing: implementerPricing,
  });

  const escalationSplit = splitTokens(
    task.escalationTokens,
    tokenUsage.escalationInput,
    tokenUsage.escalationOutput,
  );
  const escalationCost = calculateCost(
    escalationSplit.inputTokens,
    escalationSplit.outputTokens,
    resolvePricing(plannerTool, cache, plannerModel),
  );

  return implementerCost + escalationCost;
}

export function isTaskUsageCostKnown(
  task: TaskTokenUsage,
  implementerTool: string,
  plannerTool: string,
  implementerModel?: string | undefined,
  plannerModel?: string | undefined,
  cache?: ModelCacheAccessor,
): boolean {
  const taskTool = task.tool ?? implementerTool;
  const implementerKnown =
    task.implementerTokens <= 0 ||
    resolvePricing(
      taskTool,
      cache,
      resolveTaskPricingModel(taskTool, implementerTool, task.model, implementerModel),
    ).isPriced;
  const plannerKnown =
    task.escalationTokens <= 0 || resolvePricing(plannerTool, cache, plannerModel).isPriced;
  return implementerKnown && plannerKnown;
}

export function calculateCostBreakdown(
  opts: CostBreakdownOptions,
  cache?: ModelCacheAccessor,
): CostBreakdown {
  const { tokenUsage, totalTasks, escalatedCount, plannerTool, plannerModel } = opts;
  const plannerPricing = resolvePricing(plannerTool, cache, plannerModel);
  const implementerPricing = resolvePricing(opts.implementerTool, cache, opts.implementerModel);

  const hypotheticalImplementerCost = plannerPricing.isPriced
    ? calculateCost(tokenUsage.implementerInput, tokenUsage.implementerOutput, plannerPricing)
    : 0;

  const plannerInputTotal = tokenUsage.plannerInput + tokenUsage.escalationInput;
  const plannerOutputTotal = tokenUsage.plannerOutput + tokenUsage.escalationOutput;

  const actualPlannerCost = calculateUsageCost({
    inputTokens: plannerInputTotal,
    outputTokens: plannerOutputTotal,
    cacheReadTokens: tokenUsage.plannerCacheRead ?? 0,
    cacheCreateTokens: tokenUsage.plannerCacheCreate ?? 0,
    pricing: plannerPricing,
  });

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
  const isActualPlannerCostKnown = plannerUsageTokens <= 0 || plannerPricing.isPriced;
  const isActualImplementerCostKnown =
    implementerUsageTokens <= 0 || !implementerAccounting.hasUnpricedUsage;
  const isTotalActualCostKnown = isActualPlannerCostKnown && isActualImplementerCostKnown;
  const isAllPlannerBaselineKnown = implementerUsageTokens <= 0 || plannerPricing.isPriced;
  const hasSavingsEstimate = isAllPlannerBaselineKnown && isActualImplementerCostKnown;
  const savingsAmount = hasSavingsEstimate
    ? hypotheticalImplementerCost - actualImplementerCost
    : 0;
  const savingsPercentage =
    hasSavingsEstimate && hypotheticalImplementerCost > 0
      ? (savingsAmount / hypotheticalImplementerCost) * 100
      : 0;
  const localCompletionRate = totalTasks > 0 ? (totalTasks - escalatedCount) / totalTasks : 0;
  const hasPricedUsage = plannerPricing.isPriced || implementerAccounting.hasPricedUsage;
  const hasUnpricedUsage = !plannerPricing.isPriced || implementerAccounting.hasUnpricedUsage;

  const providerCosts: Record<string, ProviderCostEntry> = {};
  if (
    plannerPricing.isPriced &&
    (actualPlannerCost > 0 || plannerInputTotal > 0 || plannerOutputTotal > 0)
  ) {
    recordProviderCost(providerCosts, {
      tool: plannerTool,
      inputTokens: plannerInputTotal,
      outputTokens: plannerOutputTotal,
      cost: actualPlannerCost,
    });
  }
  for (const [tool, entry] of Object.entries(implementerAccounting.providerCosts)) {
    recordProviderCost(providerCosts, {
      tool,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cost: entry.cost,
    });
  }

  const cacheReadTokens =
    (tokenUsage.plannerCacheRead ?? 0) + (tokenUsage.implementerCacheRead ?? 0);
  const cacheWriteTokens =
    (tokenUsage.plannerCacheCreate ?? 0) + (tokenUsage.implementerCacheCreate ?? 0);

  // Cache read savings: per-token saving vs. charging those tokens at the full input rate.
  // plannerInput / implementerInput already excludes cache_read_input_tokens (API returns them
  // separately). Savings = what would have been paid at input rate minus what was actually paid.
  let cacheReadSavings = 0;
  if (cacheReadTokens > 0) {
    cacheReadSavings += calculateCacheReadSavings(tokenUsage.plannerCacheRead ?? 0, plannerPricing);
    cacheReadSavings += implementerAccounting.cacheReadSavings;
  }

  return {
    hypotheticalCost: hypotheticalImplementerCost,
    actualPlannerCost,
    actualImplementerCost,
    totalActualCost,
    savingsAmount: Math.max(0, savingsAmount),
    savingsPercentage: Math.max(0, savingsPercentage),
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
