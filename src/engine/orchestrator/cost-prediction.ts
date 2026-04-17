import type { TokenUsage, CostPrediction } from '../../core/types/summary.js';
import { getProviderPricing, calculateCost } from '../providers/pricing.js';

const DEFAULT_IMPLEMENTER_TOKENS_PER_TASK = 2000;
const DEFAULT_ESCALATION_TOKENS_PER_TASK = 500;
const DEFAULT_PLANNER_TOKENS_PER_TASK = 3000;

const LOW_ESCALATION_RATE = 0;
const EXPECTED_ESCALATION_RATE = 0.15;
const HIGH_ESCALATION_RATE = 0.40;

export type PredictCostOptions = {
  taskCount: number;
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
  tokenUsage?: TokenUsage | undefined;
};

function estimatePlannerCost(opts: PredictCostOptions): number {
  const { taskCount, plannerTool, plannerModel, tokenUsage } = opts;
  const plannerPricing = getProviderPricing(plannerTool, plannerModel);

  if (tokenUsage && (tokenUsage.plannerInput > 0 || tokenUsage.plannerOutput > 0)) {
    return calculateCost(tokenUsage.plannerInput, tokenUsage.plannerOutput, plannerPricing);
  }

  const estimatedTokens = taskCount * DEFAULT_PLANNER_TOKENS_PER_TASK;
  return calculateCost(estimatedTokens * 0.6, estimatedTokens * 0.4, plannerPricing);
}

function estimateImplementerCost(taskCount: number, escalationRate: number, plannerTool: string, implementerTool: string, plannerModel?: string, implementerModel?: string): number {
  const implementerPricing = getProviderPricing(implementerTool, implementerModel);
  const plannerPricing = getProviderPricing(plannerTool, plannerModel);

  const implementerTokens = taskCount * DEFAULT_IMPLEMENTER_TOKENS_PER_TASK;
  const implementerCost = calculateCost(implementerTokens * 0.6, implementerTokens * 0.4, implementerPricing);

  const escalatedTasks = Math.round(taskCount * escalationRate);
  const escalationTokens = escalatedTasks * DEFAULT_ESCALATION_TOKENS_PER_TASK;
  const escalationCost = calculateCost(escalationTokens * 0.6, escalationTokens * 0.4, plannerPricing);

  return implementerCost + escalationCost;
}

export function predictCost(opts: PredictCostOptions): CostPrediction {
  const { plannerTool, implementerTool, plannerModel, implementerModel } = opts;
  const taskCount = Math.max(0, opts.taskCount);

  if (taskCount === 0) {
    return { estimatedTasks: 0, lowCost: 0, expectedCost: 0, highCost: 0, plannerTool, implementerTool };
  }

  const plannerCost = estimatePlannerCost(opts);

  const lowImpl = estimateImplementerCost(taskCount, LOW_ESCALATION_RATE, plannerTool, implementerTool, plannerModel, implementerModel);
  const expectedImpl = estimateImplementerCost(taskCount, EXPECTED_ESCALATION_RATE, plannerTool, implementerTool, plannerModel, implementerModel);
  const highImpl = estimateImplementerCost(taskCount, HIGH_ESCALATION_RATE, plannerTool, implementerTool, plannerModel, implementerModel);

  return {
    estimatedTasks: taskCount,
    lowCost: plannerCost + lowImpl,
    expectedCost: plannerCost + expectedImpl,
    highCost: plannerCost + highImpl,
    plannerTool,
    implementerTool,
  };
}
