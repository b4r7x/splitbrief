import { resolveAutoModel } from '../../core/providers/model-selection.js';
import type { DetectedPricingTier } from '../../core/discovery/detection.js';
import type { ResolvedPricing } from './pricing-resolver.js';

export type ProviderCostEntry = {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  cacheReadTokens?: number | undefined;
  cacheCreateTokens?: number | undefined;
};
export type TokenSplit = { inputTokens: number; outputTokens: number };

export type ProviderUsageSegment = {
  tool: string;
  model?: string | undefined;
  primaryTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  contextTokens: number;
  usageTokens: number;
  pricing: ResolvedPricing;
  cost: number;
  costKnown: boolean;
};

export function buildProviderUsageSegment(opts: {
  tool: string;
  model?: string | undefined;
  inputTokens: number;
  outputTokens: number;
  primaryTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheCreateTokens?: number | undefined;
  pricing: ResolvedPricing;
}): ProviderUsageSegment {
  const cacheReadTokens = opts.cacheReadTokens ?? 0;
  const cacheCreateTokens = opts.cacheCreateTokens ?? 0;
  const primaryTokens = opts.primaryTokens ?? opts.inputTokens + opts.outputTokens;
  const contextTokens = opts.inputTokens + cacheReadTokens + cacheCreateTokens;
  const costKnown =
    primaryTokens <= opts.inputTokens + opts.outputTokens &&
    usageCostIsFullyKnown({
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      pricing: opts.pricing,
      contextTokens,
    });
  return {
    tool: opts.tool,
    ...(opts.model !== undefined && { model: opts.model }),
    primaryTokens,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    contextTokens,
    usageTokens: primaryTokens + cacheReadTokens + cacheCreateTokens,
    pricing: opts.pricing,
    cost: calculateUsageCost({
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      pricing: opts.pricing,
      contextTokens,
    }),
    costKnown,
  };
}

export function selectPricingForContext(
  pricing: ResolvedPricing,
  contextTokens: number,
): ResolvedPricing {
  if (!pricing.isPriced || !pricing.pricingTiers || pricing.pricingTiers.length === 0) {
    return pricing;
  }

  let selected: DetectedPricingTier | null = null;
  for (const tier of pricing.pricingTiers) {
    if (tier.type !== 'context') continue;
    if (tier.thresholdTokens > contextTokens) continue;
    if (!selected || tier.thresholdTokens > selected.thresholdTokens) selected = tier;
  }
  if (!selected) return pricing;

  const cacheReadPer1M = selected.cacheReadPer1M ?? pricing.cacheReadPer1M;
  const cacheWritePer1M = selected.cacheWritePer1M ?? pricing.cacheWritePer1M;
  return {
    ...pricing,
    inputPer1M: selected.inputPer1M ?? pricing.inputPer1M,
    outputPer1M: selected.outputPer1M ?? pricing.outputPer1M,
    ...(cacheReadPer1M !== undefined && { cacheReadPer1M }),
    ...(cacheWritePer1M !== undefined && { cacheWritePer1M }),
  };
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ResolvedPricing,
  contextTokens = inputTokens,
): number {
  if (!pricing.isPriced) return 0;
  const selectedPricing = selectPricingForContext(pricing, contextTokens);
  return (
    (inputTokens / 1_000_000) * selectedPricing.inputPer1M +
    (outputTokens / 1_000_000) * selectedPricing.outputPer1M
  );
}

export function cachePricingIsComplete(
  pricing: ResolvedPricing,
  cacheReadTokens: number,
  cacheCreateTokens: number,
): boolean {
  if (cacheReadTokens > 0 && pricing.cacheReadPer1M === undefined) return false;
  if (cacheCreateTokens > 0 && pricing.cacheWritePer1M === undefined) return false;
  return true;
}

export function usageCostIsFullyKnown(opts: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  pricing: ResolvedPricing;
  contextTokens?: number | undefined;
}): boolean {
  const contextTokens =
    opts.contextTokens ?? opts.inputTokens + opts.cacheReadTokens + opts.cacheCreateTokens;
  const pricing = selectPricingForContext(opts.pricing, contextTokens);
  const total =
    opts.inputTokens + opts.outputTokens + opts.cacheReadTokens + opts.cacheCreateTokens;
  if (total <= 0) return true;
  if (!pricing.isPriced) return false;
  return cachePricingIsComplete(pricing, opts.cacheReadTokens, opts.cacheCreateTokens);
}

export function calculateUsageCost(opts: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  pricing: ResolvedPricing;
  contextTokens?: number | undefined;
}): number {
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, pricing } = opts;
  const contextTokens = opts.contextTokens ?? inputTokens + cacheReadTokens + cacheCreateTokens;
  const selectedPricing = selectPricingForContext(pricing, contextTokens);
  const baseCost = calculateCost(inputTokens, outputTokens, selectedPricing, contextTokens);
  if (!selectedPricing.isPriced) return baseCost;
  const cacheReadCost =
    selectedPricing.cacheReadPer1M === undefined
      ? 0
      : (cacheReadTokens / 1_000_000) * selectedPricing.cacheReadPer1M;
  const cacheCreateCost =
    selectedPricing.cacheWritePer1M === undefined
      ? 0
      : (cacheCreateTokens / 1_000_000) * selectedPricing.cacheWritePer1M;
  return baseCost + cacheReadCost + cacheCreateCost;
}

export function recordProviderCost(
  providerCosts: Record<string, ProviderCostEntry>,
  entry: {
    tool: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    cacheReadTokens?: number | undefined;
    cacheCreateTokens?: number | undefined;
  },
): void {
  const { tool, inputTokens, outputTokens, cost } = entry;
  const cacheReadTokens = entry.cacheReadTokens ?? 0;
  const cacheCreateTokens = entry.cacheCreateTokens ?? 0;
  const existing = providerCosts[tool];
  if (existing) {
    existing.inputTokens += inputTokens;
    existing.outputTokens += outputTokens;
    existing.cost += cost;
    if (cacheReadTokens > 0)
      existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + cacheReadTokens;
    if (cacheCreateTokens > 0) {
      existing.cacheCreateTokens = (existing.cacheCreateTokens ?? 0) + cacheCreateTokens;
    }
    return;
  }
  providerCosts[tool] = {
    inputTokens,
    outputTokens,
    cost,
    ...(cacheReadTokens > 0 && { cacheReadTokens }),
    ...(cacheCreateTokens > 0 && { cacheCreateTokens }),
  };
}

export function splitTokens(opts: {
  tokens: number;
  inputTotal: number;
  outputTotal: number;
}): TokenSplit {
  const { tokens, inputTotal, outputTotal } = opts;
  const total = inputTotal + outputTotal;
  if (tokens <= 0 || total <= 0) return { inputTokens: 0, outputTokens: 0 };
  const inputTokens = tokens * (inputTotal / total);
  return { inputTokens, outputTokens: tokens - inputTokens };
}

export function allocatedCacheTokens(opts: {
  cacheTokens: number | undefined;
  tokens: number;
  totalTokens: number;
}): number {
  const { cacheTokens, tokens, totalTokens } = opts;
  if (cacheTokens === undefined || cacheTokens <= 0 || tokens <= 0 || totalTokens <= 0) return 0;
  return cacheTokens * (tokens / totalTokens);
}

export function calculateCacheReadSavings(
  cacheReadTokens: number,
  pricing: ResolvedPricing,
  contextTokens = cacheReadTokens,
): number {
  const selectedPricing = selectPricingForContext(pricing, contextTokens);
  if (
    !selectedPricing.isPriced ||
    selectedPricing.cacheReadPer1M === undefined ||
    cacheReadTokens <= 0
  )
    return 0;
  return (
    (cacheReadTokens / 1_000_000) * (selectedPricing.inputPer1M - selectedPricing.cacheReadPer1M)
  );
}

export function recordPricedUsage(
  providerCosts: Record<string, ProviderCostEntry>,
  entry: {
    tool: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number | undefined;
    cacheCreateTokens?: number | undefined;
    cost: number;
    pricing: ResolvedPricing;
  },
): void {
  const { tool, inputTokens, outputTokens, cost, pricing } = entry;
  const cacheReadTokens = entry.cacheReadTokens ?? 0;
  const cacheCreateTokens = entry.cacheCreateTokens ?? 0;
  if (!pricing.isPriced) return;
  if (
    cost <= 0 &&
    inputTokens <= 0 &&
    outputTokens <= 0 &&
    cacheReadTokens <= 0 &&
    cacheCreateTokens <= 0
  )
    return;
  recordProviderCost(providerCosts, {
    tool,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreateTokens,
    cost,
  });
}

export function resolveTaskPricingModel(opts: {
  taskTool: string;
  fallbackTool: string;
  taskModel?: string | undefined;
  fallbackModel?: string | undefined;
}): string | undefined {
  const { taskTool, fallbackTool, taskModel, fallbackModel } = opts;
  const trimmed = taskModel?.trim();
  if (trimmed) return resolveAutoModel(trimmed, taskTool) ?? trimmed;
  return taskTool === fallbackTool ? fallbackModel : undefined;
}
