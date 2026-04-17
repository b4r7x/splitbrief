import { API_PROVIDER_IDS } from '../../core/types/schemas/enums.js';
import type { TokenUsage, CostBreakdown } from '../../core/types/summary.js';
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

  const actualPlannerCost = calculateCost(plannerInputTotal, plannerOutputTotal, plannerPricing);

  const actualImplementerCost = calculateCost(
    tokenUsage.implementerInput, tokenUsage.implementerOutput, implementerPricing,
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
  };
}
