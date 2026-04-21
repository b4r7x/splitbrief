import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import { calculateCostBreakdown, getProviderPricing, calculateCost } from '../providers/pricing.js';
import { formatCost } from '../../core/formatting.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
  getSkippedTaskIds,
} from '../../core/state/selectors.js';

export type BuildSummaryState = Pick<WorkflowState, 'tasks' | 'tokenUsage'>;

export type SummaryBase = { feature: string; startTime: number; plannerTool: string; plannerModel?: string; implementerTool: string; implementerModel?: string; mode?: WorkflowMode };

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
  mode?: WorkflowMode;
};

export function calculateTaskCost(
  task: TaskTokenUsage,
  globalUsage: { implementerInput: number; implementerOutput: number; escalationInput: number; escalationOutput: number },
  implementerTool: string,
  plannerTool: string,
  implementerModel?: string | undefined,
  plannerModel?: string | undefined,
): number {
  const implementerPricing = getProviderPricing(implementerTool, implementerModel);
  const plannerPricing = getProviderPricing(plannerTool, plannerModel);

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
  const { feature, state, startTime, taskBreakdowns, plannerTool, plannerModel, implementerTool, implementerModel, phaseTimings, mode } = opts;
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
    plannerModel,
    implementerModel,
  });
  const estimatedCostSavings = formatCost(costBreakdown.savingsAmount);

  const costedBreakdowns = taskBreakdowns?.map(task => ({
    ...task,
    cost: calculateTaskCost(task, state.tokenUsage, implementerTool, plannerTool, implementerModel, plannerModel),
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
    ...(mode !== undefined && { mode }),
    // TODO(cost-aware-ux): once SummarySchema carries a `predictedCost` /
    // `actualVsPredicted` shape, propagate the prediction recorded earlier in
    // the workflow so the summary can render "Prediction vs actual". Schema is
    // intentionally untouched in this brief — see follow-ups in
    // docs/superpowers/specs/2026-04-22-cost-aware-task-compiler/.
  };
}
