import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { useStores } from '../../../stores/use-stores.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';
import type { PricingState } from '../layout/cost-chrome.js';
import { asReactiveModelCache, computeCostBreakdownStats } from '../cost-text.js';

interface CostStats {
  localRate: number;
  routedTasks: number;
  costBreakdown: CostBreakdown | null;
  pricingState: PricingState;
  currentTask: number;
  totalTasks: number;
  taskCompletionTimes: number[];
}

export function useCostStats(): CostStats {
  const config = configStore.useConfig();
  const pricingContext = tokensStore.use((state) => state.pricingContext);
  const perTask = tokensStore.use((state) => state.perTask);
  const modelsDevCatalog = modelCacheStore.use((s) => s.modelsDevCatalog);
  const modelsDevFetchedAt = modelCacheStore.use((s) => s.modelsDevFetchedAt);
  const providers = modelCacheStore.use((s) => s.providers);
  const modelCache = asReactiveModelCache({ modelsDevCatalog, modelsDevFetchedAt, providers });
  const [
    { tokenUsage, localCount, escalatedCount },
    { currentTask, totalTasks, taskCompletionTimes },
  ] = useStores(tokensStore, tasksStore);

  const { localRate, routedTasks, costBreakdown, pricingState } = computeCostBreakdownStats({
    config,
    pricingContext,
    perTask,
    tokenUsage,
    localCount,
    escalatedCount,
    totalTasks,
    modelCache,
  });

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
