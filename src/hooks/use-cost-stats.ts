import { workflowStore } from '../stores/workflow.js';
import { configStore } from '../stores/config.js';
import { modelCacheStore } from '../stores/model-cache.js';
import { useStores } from '../stores/use-stores.js';
import { calculateCostBreakdown } from '../engine/providers/pricing.js';
import { getRunnerDisplayName, getRunnerModelName } from '../core/config/index.js';
import { formatCost } from '../utils/format.js';
import type { CostBreakdown } from '../types.js';

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
  const [{ tokenUsage, currentTask, totalTasks, localCount, escalatedCount, taskCompletionTimes }] =
    useStores(workflowStore);

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
