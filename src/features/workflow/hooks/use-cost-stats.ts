import { tasksStore } from '../../../stores/workflow/tasks.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { useStores } from '../../../stores/use-stores.js';
import { calculateCostBreakdown } from '../../../engine/providers/pricing.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../../core/config/index.js';
import { formatCost } from '../../../core/formatting.js';
import type { CostBreakdown } from '../../../core/types/summary.js';

interface CostStats {
  localRate: number;
  costBreakdown: CostBreakdown | null;
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

export function formatCostDisplay(localRate: number, costBreakdown: CostBreakdown | null): CostDisplay {
  const showSavings = costBreakdown?.hasSavingsEstimate ?? false;
  const hasPricedUsage = costBreakdown?.hasPricedUsage ?? false;
  return {
    localRatePct: `${Math.round(localRate)}%`,
    showSavings,
    savingsText: `~${formatCost(costBreakdown?.savingsAmount ?? 0)}`,
    hasPricedUsage,
    spentText: formatCost(costBreakdown?.totalActualCost ?? 0),
  };
}

export function useCostStats(): CostStats {
  const config = configStore.useConfig();
  const [
    { tokenUsage, localCount, escalatedCount },
    { currentTask, totalTasks, taskCompletionTimes },
  ] = useStores(tokensStore, tasksStore);

  const localRate = (localCount + escalatedCount) > 0
    ? (localCount / (localCount + escalatedCount)) * 100
    : 0;

  const costBreakdown = tokenUsage
    ? calculateCostBreakdown({
        tokenUsage,
        totalTasks,
        escalatedCount,
        plannerTool: getRunnerDisplayName(config.planner),
        implementerTool: getRunnerDisplayName(config.implementer),
        plannerModel: getRunnerModelName(config.planner),
        implementerModel: getRunnerModelName(config.implementer),
      }, modelCacheStore)
    : null;

  return { localRate, costBreakdown, currentTask, totalTasks, taskCompletionTimes };
}
