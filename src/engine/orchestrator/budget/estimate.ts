import {
  resolveImplementerProfiles,
  type ResolvedImplementerProfile,
} from '../../../core/config/accessors/implementer-profiles.js';
import {
  getRunnerDisplayName,
  getRunnerModelName,
} from '../../../core/config/accessors/runner-config.js';
import type { z } from 'zod';
import type { Config } from '../../../core/schemas/config.js';
import type {
  CostPrediction,
  EstimateContextConfidenceSchema,
  EstimatePriceConfidenceSchema,
  EstimateUnknownCostReasonSchema,
} from '../../../core/schemas/summary.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ProjectContext } from '../../../core/state/types.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../../core/tokens/context-length.js';
import type { LanguageContext } from '../../spec/prompts/language-context.js';
import { calculateCost } from '../../providers/cost-math.js';
import { countByValue, uniquePush } from '../../../utils/collections.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { resolvePricing } from '../../providers/pricing-resolver.js';
import { estimateFormattedTaskPromptTokens } from '../context-routing/estimation.js';
import { resolveProfileContextLength } from '../context-routing/context-length.js';
import { buildRouteTaskOptions } from '../context-routing/route-input.js';
import { routeTaskToImplementerProfile } from '../context-routing/route.js';
import type { ContextLengthSource } from '../context-routing/types.js';
import type { TaskContextFit } from '../../../core/schemas/enums.js';
import type {
  BudgetReservation,
  RecoveryCallEstimate,
  RecoveryEstimateInput,
} from '../../../core/schemas/brief-recovery.js';
import { estimateTokens } from '../../../core/tokens/estimate.js';

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

function safeRecoveryTokenCount(value: number | undefined): value is number {
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
  const outputTokens = safeRecoveryTokenCount(input.configuredOutputCap)
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

export type EstimateContextConfidence = z.infer<typeof EstimateContextConfidenceSchema>;

export type EstimatePriceConfidence = z.infer<typeof EstimatePriceConfidenceSchema>;

export type EstimateUnknownCostReason = z.infer<typeof EstimateUnknownCostReasonSchema>;

export interface DeterministicTaskEstimate {
  taskId: TaskId;
  title: string;
  estimatedPromptTokens: number;
  selectedProfileId: string | null;
  contextFit: TaskContextFit | 'unknown';
  contextConfidence: EstimateContextConfidence;
  priceConfidence: EstimatePriceConfidence;
  estimatedImplementerCost: number | null;
  hypotheticalPlannerCost: number | null;
}

export type DeterministicEstimate = NonNullable<CostPrediction['deterministic']>;

export interface EstimateDeterministicCostOptions {
  tasks: Task[];
  context: ProjectContext;
  config: Config;
  pricingCache?: ModelCacheAccessor | undefined;
  conservativeContextLength?: number | undefined;
  languageContext?: LanguageContext | undefined;
  detectedContextLength?: number | undefined;
}

interface TaskEstimateInput {
  task: Task;
  context: ProjectContext;
  config: Config;
  profiles: ResolvedImplementerProfile[] | null;
  pricingCache?: ModelCacheAccessor | undefined;
  conservativeContextLength?: number | undefined;
  languageContext?: LanguageContext | undefined;
  detectedContextLength?: number | undefined;
}

function contextConfidence(source: ContextLengthSource | null): EstimateContextConfidence {
  if (source === 'explicit') return 'context-explicit';
  if (source === 'detected') return 'context-detected';
  if (source === 'models-dev' || source === 'known-catalog' || source === 'automatic-catalog')
    return 'context-known-catalog';
  if (source === 'runtime') return 'context-cached-provider';
  if (source === 'conservative-fallback') return 'context-conservative-fallback';
  return 'profile-unavailable';
}

function profileForContextConfidence(
  profiles: ResolvedImplementerProfile[],
  profileName: string | undefined,
): ResolvedImplementerProfile | undefined {
  if (profileName) return profiles.find((profile) => profile.name === profileName);
  return profiles.at(0);
}

function estimatePromptOnlyCost(
  tool: string,
  tokens: number,
  model?: string | undefined,
  cache?: ModelCacheAccessor | undefined,
): number | null {
  const pricing = resolvePricing(tool, cache, model);
  if (!pricing.isPriced) return null;
  return calculateCost(tokens, 0, pricing, tokens);
}

function estimateTask(opts: TaskEstimateInput): DeterministicTaskEstimate {
  const plannerTool = getRunnerDisplayName(opts.config.planner);
  const plannerModel = getRunnerModelName(opts.config.planner);
  const plannerCost = estimatePromptOnlyCost(plannerTool, 0, plannerModel, opts.pricingCache);
  const hasPlannerPrice = plannerCost !== null;

  if (!opts.profiles || opts.profiles.length === 0) {
    const estimatedPromptTokens = estimateFormattedTaskPromptTokens({
      task: opts.task,
      context: opts.context,
      languageContext: opts.languageContext,
    });
    return {
      taskId: opts.task.id,
      title: opts.task.title,
      estimatedPromptTokens,
      selectedProfileId: null,
      contextFit: 'unknown',
      contextConfidence: 'profile-unavailable',
      priceConfidence: 'profile-unavailable',
      estimatedImplementerCost: null,
      hypotheticalPlannerCost: hasPlannerPrice
        ? estimatePromptOnlyCost(
            plannerTool,
            estimatedPromptTokens,
            plannerModel,
            opts.pricingCache,
          )
        : null,
    };
  }

  const routeOptions = buildRouteTaskOptions({
    task: opts.task,
    context: opts.context,
    profiles: opts.profiles,
    ...(opts.pricingCache !== undefined && { modelCache: opts.pricingCache }),
    ...(opts.conservativeContextLength !== undefined && {
      conservativeContextLength: opts.conservativeContextLength,
    }),
    ...(opts.languageContext !== undefined && { languageContext: opts.languageContext }),
    ...(opts.detectedContextLength !== undefined && {
      detectedContextLength: opts.detectedContextLength,
    }),
  });
  const decision = routeTaskToImplementerProfile(routeOptions);
  const selectedProfile = opts.profiles.find(
    (profile) => profile.name === decision.selectedProfile,
  );
  const confidenceProfile = profileForContextConfidence(
    opts.profiles,
    decision.selectedProfile ?? decision.rejected.at(0)?.profile,
  );
  const contextSource = confidenceProfile
    ? resolveProfileContextLength(
        confidenceProfile,
        routeOptions.conservativeContextLength ?? DEFAULT_UNKNOWN_CONTEXT_LENGTH,
        opts.pricingCache,
        opts.detectedContextLength,
      ).source
    : null;
  const implementerCost = selectedProfile
    ? estimatePromptOnlyCost(
        getRunnerDisplayName(selectedProfile.config),
        decision.estimatedTokens,
        getRunnerModelName(selectedProfile.config),
        opts.pricingCache,
      )
    : null;
  const hypotheticalPlannerCost = hasPlannerPrice
    ? estimatePromptOnlyCost(plannerTool, decision.estimatedTokens, plannerModel, opts.pricingCache)
    : null;
  const priceConfidence = selectedProfile
    ? implementerCost !== null && hypotheticalPlannerCost !== null
      ? 'price-known'
      : 'price-unknown'
    : 'profile-unavailable';

  return {
    taskId: opts.task.id,
    title: opts.task.title,
    estimatedPromptTokens: decision.estimatedTokens,
    selectedProfileId: decision.selectedProfile ?? null,
    contextFit: decision.fit,
    contextConfidence: contextConfidence(contextSource),
    priceConfidence,
    estimatedImplementerCost: implementerCost,
    hypotheticalPlannerCost,
  };
}

function estimateTotals(tasks: DeterministicTaskEstimate[]): DeterministicEstimate['totals'] {
  let actual = 0;
  let planner = 0;
  const unknownCostReason: EstimateUnknownCostReason[] = [];

  for (const task of tasks) {
    if (task.selectedProfileId === null) uniquePush(unknownCostReason, 'profile-unavailable');

    if (task.estimatedImplementerCost === null) {
      uniquePush(
        unknownCostReason,
        task.selectedProfileId === null ? 'profile-unavailable' : 'implementer-price-unknown',
      );
    } else {
      actual += task.estimatedImplementerCost;
    }

    if (task.hypotheticalPlannerCost === null) {
      uniquePush(unknownCostReason, 'planner-price-unknown');
    } else {
      planner += task.hypotheticalPlannerCost;
    }
  }

  const knownActualEstimate =
    unknownCostReason.includes('implementer-price-unknown') ||
    unknownCostReason.includes('profile-unavailable')
      ? null
      : actual;
  const hypotheticalAllPlanner = unknownCostReason.includes('planner-price-unknown')
    ? null
    : planner;
  const estimatedSavings =
    knownActualEstimate === null || hypotheticalAllPlanner === null
      ? null
      : hypotheticalAllPlanner - knownActualEstimate;

  return {
    knownActualEstimate,
    hypotheticalAllPlanner,
    estimatedSavings,
    unknownCostReason,
  };
}

function fitCounts(tasks: DeterministicTaskEstimate[]): DeterministicEstimate['taskFitCounts'] {
  const counts = countByValue(tasks, (task) => task.contextFit);
  return {
    fits: counts.fits ?? 0,
    tight: counts.tight ?? 0,
    overflow: counts.overflow ?? 0,
    unknown: counts.unknown ?? 0,
  };
}

function contextConfidenceCounts(
  tasks: DeterministicTaskEstimate[],
): DeterministicEstimate['contextConfidenceCounts'] {
  const counts = countByValue(tasks, (task) => task.contextConfidence);
  return {
    contextExplicit: counts['context-explicit'] ?? 0,
    contextDetected: counts['context-detected'] ?? 0,
    contextKnownCatalog: counts['context-known-catalog'] ?? 0,
    contextCachedProvider: counts['context-cached-provider'] ?? 0,
    contextConservativeFallback: counts['context-conservative-fallback'] ?? 0,
    profileUnavailable: counts['profile-unavailable'] ?? 0,
  };
}

function priceConfidenceCounts(
  tasks: DeterministicTaskEstimate[],
): DeterministicEstimate['priceConfidenceCounts'] {
  const counts = countByValue(tasks, (task) => task.priceConfidence);
  return {
    priceKnown: counts['price-known'] ?? 0,
    priceUnknown: counts['price-unknown'] ?? 0,
    profileUnavailable: counts['profile-unavailable'] ?? 0,
  };
}

export function estimateDeterministicCost(
  opts: EstimateDeterministicCostOptions,
): DeterministicEstimate {
  let profiles: ResolvedImplementerProfile[] | null = null;
  try {
    profiles = resolveImplementerProfiles(opts.config).profiles;
  } catch {
    profiles = null;
  }

  const tasks = opts.tasks.map((task) =>
    estimateTask({
      task,
      context: opts.context,
      config: opts.config,
      profiles,
      ...(opts.pricingCache !== undefined && { pricingCache: opts.pricingCache }),
      ...(opts.conservativeContextLength !== undefined && {
        conservativeContextLength: opts.conservativeContextLength,
      }),
      ...(opts.languageContext !== undefined && { languageContext: opts.languageContext }),
      ...(opts.detectedContextLength !== undefined && {
        detectedContextLength: opts.detectedContextLength,
      }),
    }),
  );

  return {
    estimateScope: 'prompt-input-only',
    taskCount: tasks.length,
    taskFitCounts: fitCounts(tasks),
    contextConfidenceCounts: contextConfidenceCounts(tasks),
    priceConfidenceCounts: priceConfidenceCounts(tasks),
    tasks,
    totals: estimateTotals(tasks),
  };
}
