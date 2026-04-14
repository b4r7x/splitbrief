import { API_PROVIDER_IDS } from '../../core/types/schemas/enums.js';
import type { TokenUsage, CostBreakdown } from '../../core/types/summary.js';
import {
  parseModelId,
  resolvePricing,
  isApiPricedProvider,
  type ModelCacheAccessor,
  type ResolvedPricing,
} from './model-utils.js';

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

export function calculateCostBreakdown(opts: CostBreakdownOptions, cache?: ModelCacheAccessor): CostBreakdown {
  const { tokenUsage, totalTasks, escalatedCount, plannerTool, implementerTool, plannerModel, implementerModel } = opts;
  const plannerPricing = resolvePricing(plannerTool, cache, plannerModel);
  const implementerPricing = resolvePricing(implementerTool, cache, implementerModel);

  // hypotheticalImplementerCost: what the implementer tokens would have cost at planner rates.
  // Used to compute savings = how much cheaper the implementer was vs using the planner for the same work.
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
  // Savings = what it would have cost to use the planner for implementation vs what the implementer actually cost.
  // Note: planner cost is excluded from both sides — it is fixed regardless of implementer choice.
  const savingsAmount = hasSavingsEstimate ? hypotheticalImplementerCost - actualImplementerCost : 0;
  const savingsPercentage = hasSavingsEstimate && hypotheticalImplementerCost > 0 ? (savingsAmount / hypotheticalImplementerCost) * 100 : 0;
  const localCompletionRate = totalTasks > 0 ? (totalTasks - escalatedCount) / totalTasks : 0;
  const hasPricedUsage = plannerPricing.isPriced || implementerPricing.isPriced;
  const hasUnpricedUsage = !plannerPricing.isPriced || !implementerPricing.isPriced;

  const providerCosts: Record<string, { inputTokens: number; outputTokens: number; cost: number }> = {};
  if (plannerPricing.isPriced && (actualPlannerCost > 0 || plannerInputTotal > 0 || plannerOutputTotal > 0)) {
    providerCosts[plannerTool] = {
      inputTokens: plannerInputTotal,
      outputTokens: plannerOutputTotal,
      cost: actualPlannerCost,
    };
  }
  if (plannerTool !== implementerTool) {
    if (implementerPricing.isPriced && (actualImplementerCost > 0 || tokenUsage.implementerInput > 0 || tokenUsage.implementerOutput > 0)) {
      providerCosts[implementerTool] = {
        inputTokens: tokenUsage.implementerInput,
        outputTokens: tokenUsage.implementerOutput,
        cost: actualImplementerCost,
      };
    }
  } else if (plannerPricing.isPriced || implementerPricing.isPriced) {
    if (!providerCosts[plannerTool]) {
      providerCosts[plannerTool] = { inputTokens: 0, outputTokens: 0, cost: 0 };
    }
    providerCosts[plannerTool].inputTokens += tokenUsage.implementerInput;
    providerCosts[plannerTool].outputTokens += tokenUsage.implementerOutput;
    providerCosts[plannerTool].cost += actualImplementerCost;
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
