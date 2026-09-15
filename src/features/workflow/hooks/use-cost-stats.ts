import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { useStores } from '../../../stores/use-stores.js';
import { getShowSpend } from '../../../core/config/accessors/values.js';
import type { CostBreakdown } from '../../../core/schemas/summary.js';
import { localShare } from '../display/local-share.js';
import {
  asReactiveModelCache,
  computeCostBreakdownStats,
  type PricingState,
} from '../spend-text.js';

interface CostStats {
  localRate: number;
  routedTasks: number;
  costBreakdown: CostBreakdown | null;
  pricingState: PricingState;
  showSpend: boolean;
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

  const { costBreakdown, pricingState } = computeCostBreakdownStats({
    config,
    pricingContext,
    perTask,
    tokenUsage,
    modelCache,
  });
  const { rate, routedTasks } = localShare({ localCount, escalatedCount });

  return {
    localRate: rate,
    routedTasks,
    costBreakdown,
    pricingState,
    showSpend: getShowSpend(config),
    currentTask,
    totalTasks,
    taskCompletionTimes,
  };
}
