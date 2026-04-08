import type { TokenUsage, CostBreakdown, Summary, TaskTokenUsage, WorkflowState } from '../../types.js';
import { getPlannerPricing, getImplementerPricing, calculateCost } from '../../core/providers/pricing.js';

export type BuildSummaryState = Pick<WorkflowState, 'tasks' | 'completedTasks' | 'escalatedTasks' | 'skippedTasks' | 'failedTasks' | 'tokenUsage'>;

export function estimateCostSavings(tokenUsage: TokenUsage, plannerTool?: string, implementerTool?: string): string {
  const breakdown = calculateCostBreakdown({ tokenUsage, totalTasks: 0, escalatedCount: 0, plannerTool, implementerTool });
  if (breakdown.savingsAmount <= 0) return '$0.00';
  return `$${breakdown.savingsAmount.toFixed(2)}`;
}

type CostBreakdownOptions = {
  tokenUsage: TokenUsage;
  totalTasks: number;
  escalatedCount: number;
  plannerTool?: string | undefined;
  implementerTool?: string | undefined;
};

export function calculateCostBreakdown(opts: CostBreakdownOptions): CostBreakdown {
  const { tokenUsage, totalTasks, escalatedCount, plannerTool, implementerTool } = opts;
  const plannerPricing = getPlannerPricing(plannerTool ?? 'claude-code');
  const implementerPricing = getImplementerPricing(implementerTool ?? 'ollama');

  const hypotheticalCost = calculateCost(
    tokenUsage.implementerInput, tokenUsage.implementerOutput, plannerPricing,
  );

  const actualPlannerCost = calculateCost(
    tokenUsage.plannerInput + tokenUsage.escalationInput,
    tokenUsage.plannerOutput + tokenUsage.escalationOutput,
    plannerPricing,
  );

  const actualImplementerCost = calculateCost(
    tokenUsage.implementerInput, tokenUsage.implementerOutput, implementerPricing,
  );

  const totalActualCost = actualPlannerCost + actualImplementerCost;
  const savingsAmount = hypotheticalCost - totalActualCost;
  const savingsPercentage = hypotheticalCost > 0 ? (savingsAmount / hypotheticalCost) * 100 : 0;
  const localCompletionRate = totalTasks > 0 ? (totalTasks - escalatedCount) / totalTasks : 0;

  return {
    hypotheticalCost,
    actualPlannerCost,
    actualImplementerCost,
    totalActualCost,
    savingsAmount: Math.max(0, savingsAmount),
    savingsPercentage: Math.max(0, savingsPercentage),
    localCompletionRate,
  };
}

type BuildSummaryOptions = {
  feature: string;
  state: BuildSummaryState;
  startTime: number;
  taskBreakdowns?: TaskTokenUsage[];
  plannerTool?: string;
  implementerTool?: string;
};

export function buildSummary(opts: BuildSummaryOptions): Summary {
  const { feature, state, startTime, taskBreakdowns, plannerTool, implementerTool } = opts;
  const totalTasks = state.tasks.length;
  const completedByLocal = state.completedTasks.length;
  const escalatedToPlanner = state.escalatedTasks.length;
  const skipped = state.skippedTasks.length;
  const failed = state.failedTasks.length;
  const totalTime = Date.now() - startTime;
  const escalationRate = totalTasks > 0 ? escalatedToPlanner / totalTasks : 0;

  return {
    feature,
    totalTasks,
    completedByLocal,
    escalatedToPlanner,
    skipped,
    failed,
    totalTime,
    tokenUsage: state.tokenUsage,
    estimatedCostSavings: estimateCostSavings(state.tokenUsage, plannerTool, implementerTool),
    escalationRate,
    taskBreakdown: taskBreakdowns,
    costBreakdown: calculateCostBreakdown({ tokenUsage: state.tokenUsage, totalTasks, escalatedCount: escalatedToPlanner, plannerTool, implementerTool }),
    plannerTool,
    implementerTool,
  };
}
