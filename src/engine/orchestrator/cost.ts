import type { Summary, TaskTokenUsage, WorkflowState } from '../../types.js';
import { calculateCostBreakdown, getProviderPricing, calculateCost } from '../../core/providers/pricing.js';
import { formatCost } from '../../utils/format.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
  getSkippedTaskIds,
} from '../../core/state/selectors.js';

export type BuildSummaryState = Pick<WorkflowState, 'tasks' | 'tokenUsage'>;

export type SummaryBase = { feature: string; startTime: number; plannerTool: string; plannerModel?: string; implementerTool: string; implementerModel?: string };

type BuildSummaryOptions = {
  feature: string;
  state: BuildSummaryState;
  startTime: number;
  taskBreakdowns?: TaskTokenUsage[];
  plannerTool: string;
  plannerModel?: string;
  implementerTool: string;
  implementerModel?: string;
  phaseTimings?: Record<string, number>;
};

/**
 * Estimates per-task cost using global average cost-per-token.
 * This is an intentional approximation — tasks that used different models
 * during escalation share the same average rate. Acceptable for display
 * purposes; exact per-task cost would require tracking provider per attempt.
 */
export function calculateTaskCost(
  task: TaskTokenUsage,
  globalUsage: { implementerInput: number; implementerOutput: number; escalationInput: number; escalationOutput: number },
  implementerTool: string,
  plannerTool: string,
): number {
  const implementerPricing = getProviderPricing(implementerTool);
  const plannerPricing = getProviderPricing(plannerTool);

  const totalImplementerTokens = globalUsage.implementerInput + globalUsage.implementerOutput;
  const implementerCostPerToken = totalImplementerTokens > 0
    ? calculateCost(globalUsage.implementerInput, globalUsage.implementerOutput, implementerPricing) / totalImplementerTokens
    : 0;

  const totalEscalationTokens = globalUsage.escalationInput + globalUsage.escalationOutput;
  const escalationCostPerToken = totalEscalationTokens > 0
    ? calculateCost(globalUsage.escalationInput, globalUsage.escalationOutput, plannerPricing) / totalEscalationTokens
    : 0;

  return task.implementerTokens * implementerCostPerToken + task.escalationTokens * escalationCostPerToken;
}

export function buildSummary(opts: BuildSummaryOptions): Summary {
  const { feature, state, startTime, taskBreakdowns, plannerTool, plannerModel, implementerTool, implementerModel, phaseTimings } = opts;
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

  const costedBreakdowns = taskBreakdowns?.map(task => ({
    ...task,
    cost: calculateTaskCost(task, state.tokenUsage, implementerTool, plannerTool),
  }));

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
    taskBreakdown: costedBreakdowns,
    costBreakdown,
    plannerTool,
    plannerModel,
    implementerTool,
    implementerModel,
    phaseTimings,
  };
}
