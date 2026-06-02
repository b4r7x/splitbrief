import { resolveAutoModel } from '../../core/providers/model-selection.js';
import type { ResolvedPricing } from './pricing-resolver.js';

export type ProviderCostEntry = { inputTokens: number; outputTokens: number; cost: number };
export type TokenSplit = { inputTokens: number; outputTokens: number };

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ResolvedPricing,
): number {
  if (!pricing.isPriced) return 0;
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

export function calculateUsageCost(opts: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  pricing: ResolvedPricing;
}): number {
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, pricing } = opts;
  const baseCost = calculateCost(inputTokens, outputTokens, pricing);
  if (!pricing.isPriced) return baseCost;
  const cacheReadCost =
    pricing.cacheReadPer1M === undefined
      ? 0
      : (cacheReadTokens / 1_000_000) * pricing.cacheReadPer1M;
  const cacheCreateCost =
    pricing.cacheWritePer1M === undefined
      ? 0
      : (cacheCreateTokens / 1_000_000) * pricing.cacheWritePer1M;
  return baseCost + cacheReadCost + cacheCreateCost;
}

export function recordProviderCost(
  providerCosts: Record<string, ProviderCostEntry>,
  entry: { tool: string; inputTokens: number; outputTokens: number; cost: number },
): void {
  const { tool, inputTokens, outputTokens, cost } = entry;
  const existing = providerCosts[tool];
  if (existing) {
    existing.inputTokens += inputTokens;
    existing.outputTokens += outputTokens;
    existing.cost += cost;
    return;
  }
  providerCosts[tool] = { inputTokens, outputTokens, cost };
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
): number {
  if (!pricing.isPriced || pricing.cacheReadPer1M === undefined || cacheReadTokens <= 0) return 0;
  return (cacheReadTokens / 1_000_000) * (pricing.inputPer1M - pricing.cacheReadPer1M);
}

export function recordPricedUsage(
  providerCosts: Record<string, ProviderCostEntry>,
  entry: {
    tool: string;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    pricing: ResolvedPricing;
  },
): void {
  const { tool, inputTokens, outputTokens, cost, pricing } = entry;
  if (!pricing.isPriced) return;
  if (cost <= 0 && inputTokens <= 0 && outputTokens <= 0) return;
  recordProviderCost(providerCosts, { tool, inputTokens, outputTokens, cost });
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
