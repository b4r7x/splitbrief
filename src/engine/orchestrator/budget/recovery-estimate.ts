import type {
  BudgetReservation,
  RecoveryCallEstimate,
  RecoveryEstimateInput,
} from '../../../core/schemas/brief-recovery/budget.js';
import { estimateTokens } from '../../../core/tokens/estimate.js';
import { calculateCost } from '../../providers/cost-math.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { resolvePricing } from '../../providers/pricing-resolver.js';

type RecoveryPricingSnapshot = NonNullable<BudgetReservation['pricing']>;

// The persisted estimate schema deliberately stays small. Keep the pricing rates attached to
// the in-memory estimate so the reservation can persist the exact rates used for the estimate;
// a resumed operation uses the rates already persisted on its reservation instead.
function attachRecoveryPricing(
  estimate: RecoveryCallEstimate,
  pricing: RecoveryPricingSnapshot,
): RecoveryCallEstimate {
  Object.defineProperty(estimate, 'pricing', {
    configurable: false,
    enumerable: false,
    value: pricing,
    writable: false,
  });
  return estimate;
}

function isModelCacheAccessor(value: unknown): value is ModelCacheAccessor {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'getModelsDevCatalog' in value &&
    'getProviderModels' in value &&
    typeof value.getModelsDevCatalog === 'function' &&
    typeof value.getProviderModels === 'function'
  );
}

function recoveryPricingIdentity(tool: string, model: string | undefined): string {
  const identity = model === undefined ? tool : `${tool}/${model}`;
  return identity.trim().replace(/\s+/gu, '_');
}

function recoveryPricingSnapshot(
  pricingIdentity: string,
  pricing: ReturnType<typeof resolvePricing>,
): RecoveryPricingSnapshot {
  return {
    budgetUnit: 'usd',
    pricingIdentity,
    inputPer1M: pricing.inputPer1M,
    outputPer1M: pricing.outputPer1M,
  };
}

function isSafeRecoveryTokenCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
}

export type RecoveryFiniteEstimate = RecoveryCallEstimate & {
  kind: 'finite';
  amount: number;
};
export type RecoveryUnavailableEstimate = RecoveryCallEstimate & {
  kind: 'unavailable';
  amount: null;
};

export function estimateBriefRecoveryCall(input: RecoveryEstimateInput): RecoveryCallEstimate {
  const pricingCache = isModelCacheAccessor(input.pricingCache) ? input.pricingCache : undefined;
  const pricing = resolvePricing(input.plannerTool, pricingCache, input.plannerModel);
  const inputTokens = estimateTokens(input.prompt, input.plannerModel);
  const hasSafeInputTokens =
    Number.isSafeInteger(inputTokens) && inputTokens >= 0 && inputTokens <= 1_000_000_000;
  const persistedInputTokens = hasSafeInputTokens ? inputTokens : 1_000_000_000;
  const outputTokens = isSafeRecoveryTokenCount(input.configuredOutputCap)
    ? input.configuredOutputCap
    : undefined;
  const requestedIdentity = recoveryPricingIdentity(input.plannerTool, input.plannerModel);
  const pricingIdentity = pricing.isPriced
    ? recoveryPricingIdentity(input.plannerTool, pricing.name)
    : requestedIdentity;

  // A local runner is proven zero-cost even though it has no metered pricing row. Its output cap
  // is informational when omitted; remote work must always have a finite cap before admission.
  if (pricing.isLocal && !pricing.isPriced && hasSafeInputTokens) {
    const estimate: RecoveryFiniteEstimate = {
      kind: 'finite',
      budgetUnit: 'usd',
      inputTokens: persistedInputTokens,
      outputTokens: outputTokens ?? 0,
      amount: 0,
      pricingIdentity: 'local-zero',
    };
    return attachRecoveryPricing(estimate, recoveryPricingSnapshot('local-zero', pricing));
  }

  if (!hasSafeInputTokens || !pricing.isPriced || outputTokens === undefined) {
    const estimate: RecoveryUnavailableEstimate = {
      kind: 'unavailable',
      budgetUnit: 'usd',
      inputTokens: persistedInputTokens,
      outputTokens: outputTokens ?? 0,
      amount: null,
      pricingIdentity,
    };
    return estimate;
  }

  const amount = calculateCost(inputTokens, outputTokens, pricing, inputTokens);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
    return {
      kind: 'unavailable',
      budgetUnit: 'usd',
      inputTokens: persistedInputTokens,
      outputTokens,
      amount: null,
      pricingIdentity,
    } satisfies RecoveryUnavailableEstimate;
  }

  const estimate: RecoveryFiniteEstimate = {
    kind: 'finite',
    budgetUnit: 'usd',
    inputTokens: persistedInputTokens,
    outputTokens,
    amount,
    pricingIdentity,
  };
  return attachRecoveryPricing(estimate, recoveryPricingSnapshot(pricingIdentity, pricing));
}
