import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { useStores } from '../../../stores/use-stores.js';
import { calculateCostBreakdown } from '../../../engine/providers/cost.js';
import { resolvePricing, type PricingMode } from '../../../engine/providers/pricing-resolver.js';
import type { ModelCacheAccessor } from '../../../engine/providers/model/resolution.js';
import { runPricingIdentity } from '../../../core/providers/pricing-identity.js';
import { formatCost } from '../../../core/formatting.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';

export type CostPricingState = 'priced' | 'mixed' | 'local' | 'unpriced' | 'n/a';

interface CostStats {
  localRate: number;
  routedTasks: number;
  costBreakdown: CostBreakdown | null;
  pricingState: CostPricingState;
  currentTask: number;
  totalTasks: number;
  taskCompletionTimes: number[];
}

interface CostDisplay {
  localRatePct: string;
  showSavings: boolean;
  savingsText: string;
  hasPricedUsage: boolean;
  spentText: string;
}

function asReactiveModelCache(
  snapshot: Pick<
    ReturnType<typeof modelCacheStore.get>,
    'modelsDevCatalog' | 'modelsDevFetchedAt' | 'providers'
  >,
): ModelCacheAccessor {
  return {
    getModelsDevCatalog: () => {
      if (snapshot.modelsDevCatalog === null || snapshot.modelsDevFetchedAt === null) return null;
      return modelCacheStore.getModelsDevCatalog();
    },
    getProviderModels: (providerId) => {
      if (!snapshot.providers[providerId]) return null;
      return modelCacheStore.getProviderModels(providerId);
    },
  };
}

export function resolvePricingState(
  costBreakdown: CostBreakdown | null,
  plannerMode?: PricingMode | undefined,
  implementerMode?: PricingMode | undefined,
): CostPricingState {
  if (costBreakdown === null) return 'n/a';
  if (costBreakdown.hasPricedUsage && costBreakdown.hasUnpricedUsage) return 'mixed';
  if (costBreakdown.hasPricedUsage) return 'priced';
  if (plannerMode === 'unpriced-local' && implementerMode === 'unpriced-local') return 'local';
  if (plannerMode === 'unpriced-unknown' || implementerMode === 'unpriced-unknown') return 'n/a';
  return 'unpriced';
}

export function formatSpentText(
  costBreakdown: CostBreakdown | null,
  pricingState: CostPricingState,
): string {
  if (pricingState === 'priced') return formatCost(costBreakdown?.totalActualCost ?? 0);
  if (pricingState === 'mixed')
    return `${formatCost(costBreakdown?.totalActualCost ?? 0)} + unpriced`;
  return pricingState;
}

export function formatCostDisplay(
  localRate: number,
  costBreakdown: CostBreakdown | null,
): CostDisplay {
  const showSavings =
    (costBreakdown?.hasSavingsEstimate ?? false) && (costBreakdown?.savingsAmount ?? 0) > 0;
  const hasPricedUsage = costBreakdown?.hasPricedUsage ?? false;
  const pricingState = resolvePricingState(costBreakdown);
  return {
    localRatePct: `${Math.round(localRate)}%`,
    showSavings,
    savingsText: `~${formatCost(costBreakdown?.savingsAmount ?? 0)}`,
    hasPricedUsage,
    spentText: formatSpentText(costBreakdown, pricingState),
  };
}

export function useCostStats(): CostStats {
  const config = configStore.useConfig();
  const modelCache = asReactiveModelCache(
    modelCacheStore.use((s) => ({
      modelsDevCatalog: s.modelsDevCatalog,
      modelsDevFetchedAt: s.modelsDevFetchedAt,
      providers: s.providers,
    })),
  );
  const [
    { tokenUsage, localCount, escalatedCount },
    { currentTask, totalTasks, taskCompletionTimes },
  ] = useStores(tokensStore, tasksStore);

  const routedTasks = localCount + escalatedCount;
  const localRate = routedTasks > 0 ? (localCount / routedTasks) * 100 : 0;

  const { plannerTool, implementerTool, plannerModel, implementerModel } =
    runPricingIdentity(config);

  const costBreakdown = tokenUsage
    ? calculateCostBreakdown(
        {
          tokenUsage,
          totalTasks,
          escalatedCount,
          plannerTool,
          implementerTool,
          plannerModel,
          implementerModel,
        },
        modelCache,
      )
    : null;
  const plannerPricing = resolvePricing(plannerTool, modelCache, plannerModel);
  const implementerPricing = resolvePricing(implementerTool, modelCache, implementerModel);
  const pricingState = resolvePricingState(
    costBreakdown,
    plannerPricing.pricingMode,
    implementerPricing.pricingMode,
  );

  return {
    localRate,
    routedTasks,
    costBreakdown,
    pricingState,
    currentTask,
    totalTasks,
    taskCompletionTimes,
  };
}
