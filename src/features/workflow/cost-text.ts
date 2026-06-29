import { tokensStore, type PerTaskTokens, type TokensState } from '../../stores/workflow/tokens.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { configStore } from '../../stores/project/config.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { calculateCostBreakdown } from '../../engine/providers/cost.js';
import { resolvePricing, type PricingMode } from '../../engine/providers/pricing-resolver.js';
import type { ModelCacheAccessor } from '../../engine/providers/model/resolution.js';
import { runPricingIdentity } from '../../core/providers/pricing-identity.js';
import { formatCost } from '../../core/formatting.js';
import type { Config } from '../../core/schemas/config.js';
import type { CostBreakdown } from '../../core/schemas/summary.js';
import type { TaskTokenUsage, TokenUsage } from '../../core/schemas/tokens.js';
import { taskId } from '../../core/schemas/task.js';
import type { PricingState } from './layout/cost-chrome.js';

interface CostDisplay {
  localRatePct: string;
  showSavings: boolean;
  savingsText: string;
  hasPricedUsage: boolean;
  spentText: string;
}

export function asReactiveModelCache(
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

function resolvePricingState(
  costBreakdown: CostBreakdown | null,
  plannerMode?: PricingMode | undefined,
  implementerMode?: PricingMode | undefined,
): PricingState {
  if (costBreakdown === null) return 'n/a';
  if (costBreakdown.hasPricedUsage && costBreakdown.hasUnpricedUsage) return 'mixed';
  if (costBreakdown.hasPricedUsage) return 'priced';
  if (plannerMode === 'unpriced-local' && implementerMode === 'unpriced-local') return 'local';
  if (plannerMode === 'unpriced-unknown' || implementerMode === 'unpriced-unknown') return 'n/a';
  return 'unpriced';
}

export function formatSpentText(
  costBreakdown: CostBreakdown | null,
  pricingState: PricingState,
): string {
  if (pricingState === 'priced') {
    const cost = formatCost(costBreakdown?.totalActualCost ?? 0);
    return costBreakdown?.isTotalActualCostKnown === false ? `${cost} + unknown` : cost;
  }
  if (pricingState === 'mixed')
    return `${formatCost(costBreakdown?.totalActualCost ?? 0)} + unpriced`;
  return pricingState;
}

export function formatCostDisplay(
  localRate: number,
  costBreakdown: CostBreakdown | null,
  pricingState: PricingState,
): CostDisplay {
  const showSavings =
    (costBreakdown?.hasSavingsEstimate ?? false) && (costBreakdown?.savingsAmount ?? 0) > 0;
  const hasPricedUsage = costBreakdown?.hasPricedUsage ?? false;
  return {
    localRatePct: `${Math.round(localRate)}%`,
    showSavings,
    savingsText: `~${formatCost(costBreakdown?.savingsAmount ?? 0)}`,
    hasPricedUsage,
    spentText: formatSpentText(costBreakdown, pricingState),
  };
}

function reconstructTaskBreakdowns(perTask: Record<string, PerTaskTokens>): TaskTokenUsage[] {
  const breakdowns: TaskTokenUsage[] = [];
  for (const [id, record] of Object.entries(perTask)) {
    for (const attempt of record.attempts ?? []) {
      breakdowns.push({
        taskId: taskId(id),
        taskTitle: record.title,
        ...attempt,
      });
    }
  }
  return breakdowns;
}

interface CostBreakdownInputs {
  config: Config;
  pricingContext: TokensState['pricingContext'];
  perTask: Record<string, PerTaskTokens>;
  tokenUsage: TokenUsage | null;
  localCount: number;
  escalatedCount: number;
  totalTasks: number;
  modelCache: ModelCacheAccessor;
}

interface CostBreakdownStats {
  localRate: number;
  routedTasks: number;
  costBreakdown: CostBreakdown | null;
  pricingState: PricingState;
}

export function computeCostBreakdownStats(inputs: CostBreakdownInputs): CostBreakdownStats {
  const { config, pricingContext, perTask, tokenUsage, localCount, escalatedCount, totalTasks } =
    inputs;
  const routedTasks = localCount + escalatedCount;
  const localRate = routedTasks > 0 ? (localCount / routedTasks) * 100 : 0;

  const sessionIdentity = pricingContext ?? runPricingIdentity(config);
  const { plannerTool, implementerTool, plannerModel, implementerModel } = sessionIdentity;

  const taskBreakdowns = reconstructTaskBreakdowns(perTask);
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
          ...(taskBreakdowns.length > 0 && { taskBreakdowns }),
        },
        inputs.modelCache,
      )
    : null;
  const plannerPricing = resolvePricing(plannerTool, inputs.modelCache, plannerModel);
  const implementerPricing = resolvePricing(implementerTool, inputs.modelCache, implementerModel);
  const pricingState = resolvePricingState(
    costBreakdown,
    plannerPricing.pricingMode,
    implementerPricing.pricingMode,
  );

  return { localRate, routedTasks, costBreakdown, pricingState };
}

// Non-reactive read of the cost figure shown in the sidebar footer (`formatSpentText`), for copy
// affordances that run outside React (the `/copy cost` command and the `y` yank). Returns null when
// no priced usage exists yet — matching the sidebar, which only paints the $ figure once priced.
export function readCostText(): string | null {
  const config = configStore.get().config;
  if (!config) return null;
  const tokens = tokensStore.get();
  const { localRate, costBreakdown, pricingState } = computeCostBreakdownStats({
    config,
    pricingContext: tokens.pricingContext,
    perTask: tokens.perTask,
    tokenUsage: tokens.tokenUsage,
    localCount: tokens.localCount,
    escalatedCount: tokens.escalatedCount,
    totalTasks: tasksStore.get().totalTasks,
    modelCache: asReactiveModelCache(modelCacheStore.get()),
  });
  const display = formatCostDisplay(localRate, costBreakdown, pricingState);
  return display.hasPricedUsage ? display.spentText : null;
}
