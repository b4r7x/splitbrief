import type { Summary, TaskTokenUsage, WorkflowState } from '../../types.js';
import { calculateCostBreakdown } from '../../core/providers/pricing.js';
import { formatCost } from '../../utils/format.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
  getSkippedTaskIds,
} from '../../core/state/selectors.js';

export type BuildSummaryState = Pick<WorkflowState, 'tasks' | 'tokenUsage'>;

export type SummaryBase = { feature: string; startTime: number; plannerTool: string; implementerTool: string };

type BuildSummaryOptions = {
  feature: string;
  state: BuildSummaryState;
  startTime: number;
  taskBreakdowns?: TaskTokenUsage[];
  plannerTool: string;
  implementerTool: string;
};

export function buildSummary(opts: BuildSummaryOptions): Summary {
  const { feature, state, startTime, taskBreakdowns, plannerTool, implementerTool } = opts;
  const totalTasks = state.tasks.length;
  const completedByLocal = getCompletedTaskIds(state).length;
  const escalatedToPlanner = getEscalatedTaskIds(state).length;
  const skipped = getSkippedTaskIds(state).length;
  const failed = getFailedTaskIds(state).length;
  const totalTime = Date.now() - startTime;
  const escalationRate = totalTasks > 0 ? escalatedToPlanner / totalTasks : 0;

  const costBreakdown = calculateCostBreakdown({
    tokenUsage: state.tokenUsage,
    totalTasks,
    escalatedCount: escalatedToPlanner,
    plannerTool,
    implementerTool,
  });
  const estimatedCostSavings = formatCost(costBreakdown.savingsAmount);

  return {
    feature,
    totalTasks,
    completedByLocal,
    escalatedToPlanner,
    skipped,
    failed,
    totalTime,
    tokenUsage: state.tokenUsage,
    estimatedCostSavings,
    escalationRate,
    taskBreakdown: taskBreakdowns,
    costBreakdown,
    plannerTool,
    implementerTool,
  };
}
