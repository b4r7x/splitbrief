// Cache token population by runner kind:
// - api / agent-sdk: populated from API response when SDK exposes cache_read_input_tokens
// - cli (claude-code): best-effort; populated when tool stream includes cache fields
// - cli (other), shell, agent: not available; cache fields absent in TokenUsage
// When absent, cacheReadSavings is 0 and cache columns render 'n/a' in TUI.

import { API_PROVIDER_IDS } from '../../core/schemas/enums.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
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
};

type ProviderCostEntry = { inputTokens: number; outputTokens: number; cost: number };

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

export function calculateCostBreakdown(opts: CostBreakdownOptions, cache?: ModelCacheAccessor): CostBreakdown {
  const { tokenUsage, totalTasks, escalatedCount, plannerTool, implementerTool, plannerModel, implementerModel } = opts;
  const plannerPricing = resolvePricing(plannerTool, cache, plannerModel);
  const implementerPricing = resolvePricing(implementerTool, cache, implementerModel);

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

  const actualImplementerCost = calculateUsageCost(
    tokenUsage.implementerInput,
    tokenUsage.implementerOutput,
    tokenUsage.implementerCacheRead ?? 0,
    tokenUsage.implementerCacheCreate ?? 0,
    implementerPricing,
  );

  const totalActualCost = actualPlannerCost + actualImplementerCost;
  const hasSavingsEstimate = plannerPricing.isPriced;
  const savingsAmount = hasSavingsEstimate ? hypotheticalImplementerCost - actualImplementerCost : 0;
  const savingsPercentage = hasSavingsEstimate && hypotheticalImplementerCost > 0 ? (savingsAmount / hypotheticalImplementerCost) * 100 : 0;
  const localCompletionRate = totalTasks > 0 ? (totalTasks - escalatedCount) / totalTasks : 0;
  const hasPricedUsage = plannerPricing.isPriced || implementerPricing.isPriced;
  const hasUnpricedUsage = !plannerPricing.isPriced || !implementerPricing.isPriced;

  const providerCosts: Record<string, ProviderCostEntry> = {};
  if (plannerPricing.isPriced && (actualPlannerCost > 0 || plannerInputTotal > 0 || plannerOutputTotal > 0)) {
    recordProviderCost(providerCosts, plannerTool, plannerInputTotal, plannerOutputTotal, actualPlannerCost);
  }
  if (plannerTool !== implementerTool) {
    if (implementerPricing.isPriced && (actualImplementerCost > 0 || tokenUsage.implementerInput > 0 || tokenUsage.implementerOutput > 0)) {
      recordProviderCost(providerCosts, implementerTool, tokenUsage.implementerInput, tokenUsage.implementerOutput, actualImplementerCost);
    }
  } else if (plannerPricing.isPriced || implementerPricing.isPriced) {
    recordProviderCost(providerCosts, plannerTool, tokenUsage.implementerInput, tokenUsage.implementerOutput, actualImplementerCost);
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
    if ((tokenUsage.plannerCacheRead ?? 0) > 0 && plannerPricing.cacheReadPer1M !== undefined) {
      cacheReadSavings +=
        ((tokenUsage.plannerCacheRead ?? 0) / 1_000_000) *
        (plannerPricing.inputPer1M - plannerPricing.cacheReadPer1M);
    }
    if ((tokenUsage.implementerCacheRead ?? 0) > 0 && implementerPricing.cacheReadPer1M !== undefined) {
      cacheReadSavings +=
        ((tokenUsage.implementerCacheRead ?? 0) / 1_000_000) *
        (implementerPricing.inputPer1M - implementerPricing.cacheReadPer1M);
    }
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
    providerCosts: Object.keys(providerCosts).length > 0 ? providerCosts : undefined,
    ...(cacheReadSavings > 0 && { cacheReadSavings }),
    ...(cacheReadTokens > 0 && { cacheReadTokens }),
    ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
  };
}
