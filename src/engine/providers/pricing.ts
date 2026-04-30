// Cache token population by runner kind:
// - api / agent-sdk: populated from API response when SDK exposes cache_read_input_tokens
// - cli (claude-code): best-effort; populated when tool stream includes cache fields
// - cli (other), shell, agent: not available; cache fields absent in TokenUsage
// When absent, cacheReadSavings is 0 and cache columns render 'n/a' in TUI.

import { API_PROVIDER_IDS } from '../../core/schemas/enums.js';
import { resolveAutoModel } from '../../core/providers/model-selection.js';
import type { TaskTokenUsage, TokenUsage } from '../../core/schemas/tokens.js';
import type { CostBreakdown } from '../../core/schemas/summary.js';
import { parseModelId } from './model-parsing.js';
import { resolvePricing, isApiPricedProvider, type ResolvedPricing } from './pricing-resolver.js';
import type { ModelCacheAccessor } from './model-resolution.js';

export function getModelPricing(model: string, cache?: ModelCacheAccessor): ResolvedPricing | undefined {
  const parsed = parseModelId(model);
  if (parsed.provider && isApiPricedProvider(parsed.provider)) {
    const direct = resolvePricing(parsed.provider, cache, model);
    return direct.isPriced ? direct : undefined;
  }

  for (const providerId of API_PROVIDER_IDS) {
    const resolved = resolvePricing(providerId, cache, model);
    if (resolved.isPriced) return resolved;
  }

  return undefined;
}

export function getProviderPricing(tool: string, model?: string, cache?: ModelCacheAccessor): ResolvedPricing {
  return resolvePricing(tool, cache, model);
}

export function calculateCost(inputTokens: number, outputTokens: number, pricing: ResolvedPricing): number {
  if (!pricing.isPriced) return 0;
  return (inputTokens / 1_000_000) * pricing.inputPer1M +
         (outputTokens / 1_000_000) * pricing.outputPer1M;
}

export function calculateUsageCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
  pricing: ResolvedPricing,
): number {
  const baseCost = calculateCost(inputTokens, outputTokens, pricing);
  if (!pricing.isPriced) return baseCost;
  const cacheReadCost = pricing.cacheReadPer1M === undefined
    ? 0
    : (cacheReadTokens / 1_000_000) * pricing.cacheReadPer1M;
  const cacheCreateCost = pricing.cacheWritePer1M === undefined
    ? 0
    : (cacheCreateTokens / 1_000_000) * pricing.cacheWritePer1M;
  return baseCost + cacheReadCost + cacheCreateCost;
}

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

type ProviderCostEntry = { inputTokens: number; outputTokens: number; cost: number };
type TokenSplit = { inputTokens: number; outputTokens: number };
type ImplementerCostAccounting = {
  actualImplementerCost: number;
  hasPricedUsage: boolean;
  hasUnpricedUsage: boolean;
  providerCosts: Record<string, ProviderCostEntry>;
  cacheReadSavings: number;
};

function recordProviderCost(
  providerCosts: Record<string, ProviderCostEntry>,
  tool: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
): void {
  const existing = providerCosts[tool];
  if (existing) {
    existing.inputTokens += inputTokens;
    existing.outputTokens += outputTokens;
    existing.cost += cost;
    return;
  }
  providerCosts[tool] = { inputTokens, outputTokens, cost };
}

function splitTokens(tokens: number, inputTotal: number, outputTotal: number): TokenSplit {
  const total = inputTotal + outputTotal;
  if (tokens <= 0 || total <= 0) return { inputTokens: 0, outputTokens: 0 };
  const inputTokens = tokens * (inputTotal / total);
  return { inputTokens, outputTokens: tokens - inputTokens };
}

function allocatedCacheTokens(cacheTokens: number | undefined, tokens: number, totalTokens: number): number {
  if (cacheTokens === undefined || cacheTokens <= 0 || tokens <= 0 || totalTokens <= 0) return 0;
  return cacheTokens * (tokens / totalTokens);
}

function calculateCacheReadSavings(cacheReadTokens: number, pricing: ResolvedPricing): number {
  if (!pricing.isPriced || pricing.cacheReadPer1M === undefined || cacheReadTokens <= 0) return 0;
  return (cacheReadTokens / 1_000_000) * (pricing.inputPer1M - pricing.cacheReadPer1M);
}

function recordPricedUsage(
  providerCosts: Record<string, ProviderCostEntry>,
  tool: string,
  inputTokens: number,
  outputTokens: number,
  cost: number,
  pricing: ResolvedPricing,
): void {
  if (!pricing.isPriced) return;
  if (cost <= 0 && inputTokens <= 0 && outputTokens <= 0) return;
  recordProviderCost(providerCosts, tool, inputTokens, outputTokens, cost);
}

function resolveTaskPricingModel(
  taskTool: string,
  fallbackTool: string,
  taskModel?: string | undefined,
  fallbackModel?: string | undefined,
): string | undefined {
  const trimmed = taskModel?.trim();
  if (trimmed) return resolveAutoModel(trimmed, taskTool) ?? trimmed;
  return taskTool === fallbackTool ? fallbackModel : undefined;
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
  const cost = calculateUsageCost(
    opts.inputTokens,
    opts.outputTokens,
    opts.cacheReadTokens,
    opts.cacheCreateTokens,
    pricing,
  );

  accounting.actualImplementerCost += cost;
  accounting.cacheReadSavings += calculateCacheReadSavings(opts.cacheReadTokens, pricing);
  if (pricing.isPriced) {
    accounting.hasPricedUsage = true;
  } else {
    accounting.hasUnpricedUsage = true;
  }
  recordPricedUsage(
    accounting.providerCosts,
    opts.tool,
    opts.inputTokens,
    opts.outputTokens,
    cost,
    pricing,
  );
}

function calculateAggregateImplementerCost(opts: CostBreakdownOptions, pricing: ResolvedPricing): ImplementerCostAccounting {
  const { tokenUsage, implementerTool } = opts;
  const actualImplementerCost = calculateUsageCost(
    tokenUsage.implementerInput,
    tokenUsage.implementerOutput,
    tokenUsage.implementerCacheRead ?? 0,
    tokenUsage.implementerCacheCreate ?? 0,
    pricing,
  );
  const providerCosts: Record<string, ProviderCostEntry> = {};
  recordPricedUsage(
    providerCosts,
    implementerTool,
    tokenUsage.implementerInput,
    tokenUsage.implementerOutput,
    actualImplementerCost,
    pricing,
  );

  return {
    actualImplementerCost,
    hasPricedUsage: pricing.isPriced,
    hasUnpricedUsage: !pricing.isPriced,
    providerCosts,
    cacheReadSavings: calculateCacheReadSavings(tokenUsage.implementerCacheRead ?? 0, pricing),
  };
}

function calculateTaskAwareImplementerCost(opts: CostBreakdownOptions, cache?: ModelCacheAccessor): ImplementerCostAccounting | undefined {
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
    applyImplementerUsageCost(accounting, {
      tool,
      model: resolveTaskPricingModel(tool, implementerTool, task.model, implementerModel),
      inputTokens,
      outputTokens,
      cacheReadTokens: allocatedCacheTokens(tokenUsage.implementerCacheRead, task.implementerTokens, totalImplementerTokens),
      cacheCreateTokens: allocatedCacheTokens(tokenUsage.implementerCacheCreate, task.implementerTokens, totalImplementerTokens),
    }, cache);
    accountedTokens += task.implementerTokens;
  }

  const residualTokens = Math.max(0, totalImplementerTokens - accountedTokens);
  if (residualTokens > 0) {
    const { inputTokens, outputTokens } = splitTokens(
      residualTokens,
      tokenUsage.implementerInput,
      tokenUsage.implementerOutput,
    );
    applyImplementerUsageCost(accounting, {
      tool: implementerTool,
      model: implementerModel,
      inputTokens,
      outputTokens,
      cacheReadTokens: allocatedCacheTokens(tokenUsage.implementerCacheRead, residualTokens, totalImplementerTokens),
      cacheCreateTokens: allocatedCacheTokens(tokenUsage.implementerCacheCreate, residualTokens, totalImplementerTokens),
    }, cache);
  }

  return accounting;
}

export type TaskCostTokenUsage = Pick<TokenUsage,
  | 'implementerInput'
  | 'implementerOutput'
  | 'escalationInput'
  | 'escalationOutput'
  | 'implementerCacheRead'
  | 'implementerCacheCreate'
>;

export function calculateTaskUsageCost(
  task: TaskTokenUsage,
  tokenUsage: TaskCostTokenUsage,
  implementerTool: string,
  plannerTool: string,
  implementerModel?: string | undefined,
  plannerModel?: string | undefined,
  cache?: ModelCacheAccessor,
): number {
  const totalImplementerTokens = tokenUsage.implementerInput + tokenUsage.implementerOutput;
  const implementerSplit = splitTokens(task.implementerTokens, tokenUsage.implementerInput, tokenUsage.implementerOutput);
  const taskTool = task.tool ?? implementerTool;
  const implementerPricing = resolvePricing(
    taskTool,
    cache,
    resolveTaskPricingModel(taskTool, implementerTool, task.model, implementerModel),
  );
  const implementerCost = calculateUsageCost(
    implementerSplit.inputTokens,
    implementerSplit.outputTokens,
    allocatedCacheTokens(tokenUsage.implementerCacheRead, task.implementerTokens, totalImplementerTokens),
    allocatedCacheTokens(tokenUsage.implementerCacheCreate, task.implementerTokens, totalImplementerTokens),
    implementerPricing,
  );

  const escalationSplit = splitTokens(task.escalationTokens, tokenUsage.escalationInput, tokenUsage.escalationOutput);
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
  const implementerKnown = task.implementerTokens <= 0 || resolvePricing(
    taskTool,
    cache,
    resolveTaskPricingModel(taskTool, implementerTool, task.model, implementerModel),
  ).isPriced;
  const plannerKnown = task.escalationTokens <= 0 || resolvePricing(plannerTool, cache, plannerModel).isPriced;
  return implementerKnown && plannerKnown;
}

export function calculateCostBreakdown(opts: CostBreakdownOptions, cache?: ModelCacheAccessor): CostBreakdown {
  const { tokenUsage, totalTasks, escalatedCount, plannerTool, plannerModel } = opts;
  const plannerPricing = resolvePricing(plannerTool, cache, plannerModel);
  const implementerPricing = resolvePricing(opts.implementerTool, cache, opts.implementerModel);

  const hypotheticalImplementerCost = plannerPricing.isPriced
    ? calculateCost(tokenUsage.implementerInput, tokenUsage.implementerOutput, plannerPricing)
    : 0;

  const plannerInputTotal = tokenUsage.plannerInput + tokenUsage.escalationInput;
  const plannerOutputTotal = tokenUsage.plannerOutput + tokenUsage.escalationOutput;

  const actualPlannerCost = calculateUsageCost(
    plannerInputTotal,
    plannerOutputTotal,
    tokenUsage.plannerCacheRead ?? 0,
    tokenUsage.plannerCacheCreate ?? 0,
    plannerPricing,
  );

  const implementerAccounting = calculateTaskAwareImplementerCost(opts, cache)
    ?? calculateAggregateImplementerCost(opts, implementerPricing);
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
  const isActualImplementerCostKnown = implementerUsageTokens <= 0 || !implementerAccounting.hasUnpricedUsage;
  const isTotalActualCostKnown = isActualPlannerCostKnown && isActualImplementerCostKnown;
  const isAllPlannerBaselineKnown = implementerUsageTokens <= 0 || plannerPricing.isPriced;
  const hasSavingsEstimate = isAllPlannerBaselineKnown && isActualImplementerCostKnown;
  const savingsAmount = hasSavingsEstimate ? hypotheticalImplementerCost - actualImplementerCost : 0;
  const savingsPercentage = hasSavingsEstimate && hypotheticalImplementerCost > 0 ? (savingsAmount / hypotheticalImplementerCost) * 100 : 0;
  const localCompletionRate = totalTasks > 0 ? (totalTasks - escalatedCount) / totalTasks : 0;
  const hasPricedUsage = plannerPricing.isPriced || implementerAccounting.hasPricedUsage;
  const hasUnpricedUsage = !plannerPricing.isPriced || implementerAccounting.hasUnpricedUsage;

  const providerCosts: Record<string, ProviderCostEntry> = {};
  if (plannerPricing.isPriced && (actualPlannerCost > 0 || plannerInputTotal > 0 || plannerOutputTotal > 0)) {
    recordProviderCost(providerCosts, plannerTool, plannerInputTotal, plannerOutputTotal, actualPlannerCost);
  }
  for (const [tool, entry] of Object.entries(implementerAccounting.providerCosts)) {
    recordProviderCost(providerCosts, tool, entry.inputTokens, entry.outputTokens, entry.cost);
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
