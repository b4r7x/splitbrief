import { workflowStore } from '../stores/workflow.js';
import { configStore } from '../stores/config.js';
import { calculateCostBreakdown } from '../core/providers/pricing.js';
import { getPlannerToolName } from '../core/config/planner-config.js';
import type { CostBreakdown } from '../types.js';

export interface CostStats {
  localRate: number;
  costBreakdown: CostBreakdown | null;
  currentTask: number;
  totalTasks: number;
}

export function useCostStats(): CostStats {
  const config = configStore.useConfig();
  const tokenUsage = workflowStore.use(s => s.tokenUsage);
  const currentTask = workflowStore.use(s => s.currentTask);
  const totalTasks = workflowStore.use(s => s.totalTasks);
  const localCount = workflowStore.use(s => s.localCount);
  const escalatedCount = workflowStore.use(s => s.escalatedCount);

  const localRate = (localCount + escalatedCount) > 0
    ? (localCount / (localCount + escalatedCount)) * 100
    : 0;

  const costBreakdown = tokenUsage
    ? calculateCostBreakdown({
        tokenUsage,
        totalTasks,
        escalatedCount,
        plannerTool: getPlannerToolName(config.planner),
        implementerTool: config.implementer.tool,
      })
    : null;

  return { localRate, costBreakdown, currentTask, totalTasks };
}
