import { resolveImplementerProfiles, type ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import type { Config } from '../../../core/schemas/config.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { LanguageContext } from '../../spec/prompts/language-context.js';
import { calculateCost } from '../../providers/pricing.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { resolvePricing } from '../../providers/pricing-resolver.js';
import {
  estimateFormattedTaskPromptTokens,
  resolveProfileContextLength,
  routeTaskToImplementerProfile,
  type ContextLengthSource,
  type TaskContextFit,
} from '../context-routing.js';

export type EstimateContextConfidence =
  | 'context-explicit'
  | 'context-known-catalog'
  | 'context-cached-provider'
  | 'context-conservative-fallback'
  | 'profile-unavailable';

export type EstimatePriceConfidence = 'price-known' | 'price-unknown' | 'profile-unavailable';

export type EstimateUnknownCostReason =
  | 'implementer-price-unknown'
  | 'planner-price-unknown'
  | 'profile-unavailable';

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
}

interface TaskEstimateInput {
  task: Task;
  context: ProjectContext;
  config: Config;
  profiles: ResolvedImplementerProfile[] | null;
  pricingCache?: ModelCacheAccessor | undefined;
  conservativeContextLength?: number | undefined;
  languageContext?: LanguageContext | undefined;
}

const DEFAULT_CONSERVATIVE_CONTEXT_LENGTH = 8192;

function contextConfidence(source: ContextLengthSource | null): EstimateContextConfidence {
  if (source === 'explicit') return 'context-explicit';
  if (source === 'models-dev' || source === 'known-catalog') return 'context-known-catalog';
  if (source === 'runtime') return 'context-cached-provider';
  if (source === 'conservative-fallback') return 'context-conservative-fallback';
  return 'profile-unavailable';
}

function pushUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function profileForContextConfidence(
  profiles: ResolvedImplementerProfile[],
  profileName: string | undefined,
): ResolvedImplementerProfile | undefined {
  if (profileName) return profiles.find(profile => profile.name === profileName);
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
  return calculateCost(tokens, 0, pricing);
}

function estimateTask(opts: TaskEstimateInput): DeterministicTaskEstimate {
  const plannerTool = getRunnerDisplayName(opts.config.planner);
  const plannerModel = getRunnerModelName(opts.config.planner);
  const plannerCost = estimatePromptOnlyCost(plannerTool, 0, plannerModel, opts.pricingCache);
  const hasPlannerPrice = plannerCost !== null;

  if (!opts.profiles || opts.profiles.length === 0) {
    const estimatedPromptTokens = estimateFormattedTaskPromptTokens({ task: opts.task, context: opts.context, languageContext: opts.languageContext });
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
        ? estimatePromptOnlyCost(plannerTool, estimatedPromptTokens, plannerModel, opts.pricingCache)
        : null,
    };
  }

  const decision = routeTaskToImplementerProfile({
    task: opts.task,
    context: opts.context,
    profiles: opts.profiles,
    ...(opts.conservativeContextLength !== undefined && { conservativeContextLength: opts.conservativeContextLength }),
    ...(opts.pricingCache !== undefined && { contextCache: opts.pricingCache }),
    ...(opts.languageContext !== undefined && { languageContext: opts.languageContext }),
  });
  const selectedProfile = opts.profiles.find(profile => profile.name === decision.selectedProfile);
  const confidenceProfile = profileForContextConfidence(opts.profiles, decision.selectedProfile ?? decision.rejected.at(0)?.profile);
  const contextSource = confidenceProfile
    ? resolveProfileContextLength(
      confidenceProfile,
      opts.conservativeContextLength ?? DEFAULT_CONSERVATIVE_CONTEXT_LENGTH,
      opts.pricingCache,
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
    ? implementerCost !== null && hypotheticalPlannerCost !== null ? 'price-known' : 'price-unknown'
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
    if (task.selectedProfileId === null) pushUnique(unknownCostReason, 'profile-unavailable');

    if (task.estimatedImplementerCost === null) {
      pushUnique(unknownCostReason, task.selectedProfileId === null ? 'profile-unavailable' : 'implementer-price-unknown');
    } else {
      actual += task.estimatedImplementerCost;
    }

    if (task.hypotheticalPlannerCost === null) {
      pushUnique(unknownCostReason, 'planner-price-unknown');
    } else {
      planner += task.hypotheticalPlannerCost;
    }
  }

  const knownActualEstimate = unknownCostReason.includes('implementer-price-unknown') || unknownCostReason.includes('profile-unavailable')
    ? null
    : actual;
  const hypotheticalAllPlanner = unknownCostReason.includes('planner-price-unknown') ? null : planner;
  const estimatedSavings = knownActualEstimate === null || hypotheticalAllPlanner === null
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
  return {
    fits: tasks.filter(task => task.contextFit === 'fits').length,
    tight: tasks.filter(task => task.contextFit === 'tight').length,
    overflow: tasks.filter(task => task.contextFit === 'overflow').length,
    unknown: tasks.filter(task => task.contextFit === 'unknown').length,
  };
}

function contextConfidenceCounts(tasks: DeterministicTaskEstimate[]): DeterministicEstimate['contextConfidenceCounts'] {
  return {
    contextExplicit: tasks.filter(task => task.contextConfidence === 'context-explicit').length,
    contextKnownCatalog: tasks.filter(task => task.contextConfidence === 'context-known-catalog').length,
    contextCachedProvider: tasks.filter(task => task.contextConfidence === 'context-cached-provider').length,
    contextConservativeFallback: tasks.filter(task => task.contextConfidence === 'context-conservative-fallback').length,
    profileUnavailable: tasks.filter(task => task.contextConfidence === 'profile-unavailable').length,
  };
}

function priceConfidenceCounts(tasks: DeterministicTaskEstimate[]): DeterministicEstimate['priceConfidenceCounts'] {
  return {
    priceKnown: tasks.filter(task => task.priceConfidence === 'price-known').length,
    priceUnknown: tasks.filter(task => task.priceConfidence === 'price-unknown').length,
    profileUnavailable: tasks.filter(task => task.priceConfidence === 'profile-unavailable').length,
  };
}

export function estimateDeterministicCost(opts: EstimateDeterministicCostOptions): DeterministicEstimate {
  let profiles: ResolvedImplementerProfile[] | null = null;
  try {
    profiles = resolveImplementerProfiles(opts.config).profiles;
  } catch {
    profiles = null;
  }

  const tasks = opts.tasks.map(task => estimateTask({
    task,
    context: opts.context,
    config: opts.config,
    profiles,
    ...(opts.pricingCache !== undefined && { pricingCache: opts.pricingCache }),
    ...(opts.conservativeContextLength !== undefined && { conservativeContextLength: opts.conservativeContextLength }),
    ...(opts.languageContext !== undefined && { languageContext: opts.languageContext }),
  }));

  return {
    taskCount: tasks.length,
    taskFitCounts: fitCounts(tasks),
    contextConfidenceCounts: contextConfidenceCounts(tasks),
    priceConfidenceCounts: priceConfidenceCounts(tasks),
    tasks,
    totals: estimateTotals(tasks),
  };
}
