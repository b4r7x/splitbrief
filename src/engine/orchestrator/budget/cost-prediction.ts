import type { TokenUsage } from '../../../core/schemas/tokens.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import { calculateCost } from '../../providers/cost-math.js';
import { resolvePricing } from '../../providers/pricing-resolver.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';

const DEFAULT_IMPLEMENTER_TOKENS_PER_TASK = 2000;
const DEFAULT_ESCALATION_TOKENS_PER_TASK = 500;
const DEFAULT_PLANNER_TOKENS_PER_TASK = 3000;

// Escalation-rate scenarios used to bracket the cost prediction:
//   - low      = no escalation (every task handled by the cheap implementer)
//   - expected = ~15% planner fallback (typical mix in steady state)
//   - high     = ~40% planner fallback (worst-case: most tasks escalated)
const LOW_ESCALATION_RATE = 0;
const EXPECTED_ESCALATION_RATE = 0.15;
const HIGH_ESCALATION_RATE = 0.4;

export type PredictCostOptions = {
  taskCount: number;
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
  tokenUsage?: TokenUsage | undefined;
  cache?: ModelCacheAccessor | undefined;
};

function estimatePlannerCost(opts: PredictCostOptions): number {
  const { taskCount, plannerTool, plannerModel, tokenUsage } = opts;
  const plannerPricing = resolvePricing(plannerTool, opts.cache, plannerModel);

  if (tokenUsage && (tokenUsage.plannerInput > 0 || tokenUsage.plannerOutput > 0)) {
    return calculateCost(tokenUsage.plannerInput, tokenUsage.plannerOutput, plannerPricing);
  }

  const estimatedTokens = taskCount * DEFAULT_PLANNER_TOKENS_PER_TASK;
  return calculateCost(estimatedTokens * 0.6, estimatedTokens * 0.4, plannerPricing);
}

function estimateImplementerCost(
  opts: {
    taskCount: number;
    escalationRate: number;
    plannerTool: string;
    implementerTool: string;
    plannerModel?: string | undefined;
    implementerModel?: string | undefined;
  },
  cache?: ModelCacheAccessor,
): number {
  const {
    taskCount,
    escalationRate,
    plannerTool,
    implementerTool,
    plannerModel,
    implementerModel,
  } = opts;
  const implementerPricing = resolvePricing(implementerTool, cache, implementerModel);
  const plannerPricing = resolvePricing(plannerTool, cache, plannerModel);

  const implementerTokens = taskCount * DEFAULT_IMPLEMENTER_TOKENS_PER_TASK;
  const implementerCost = calculateCost(
    implementerTokens * 0.6,
    implementerTokens * 0.4,
    implementerPricing,
  );

  const escalatedTasks = Math.round(taskCount * escalationRate);
  const escalationTokens = escalatedTasks * DEFAULT_ESCALATION_TOKENS_PER_TASK;
  const escalationCost = calculateCost(
    escalationTokens * 0.6,
    escalationTokens * 0.4,
    plannerPricing,
  );

  return implementerCost + escalationCost;
}

export function predictCost(opts: PredictCostOptions): CostPrediction {
  const { plannerTool, implementerTool, plannerModel, implementerModel } = opts;
  const taskCount = Math.max(0, opts.taskCount);

  if (taskCount === 0) {
    return {
      estimatedTasks: 0,
      lowCost: 0,
      expectedCost: 0,
      highCost: 0,
      plannerTool,
      implementerTool,
    };
  }

  const plannerCost = estimatePlannerCost(opts);

  const lowImpl = estimateImplementerCost(
    {
      taskCount,
      escalationRate: LOW_ESCALATION_RATE,
      plannerTool,
      implementerTool,
      plannerModel,
      implementerModel,
    },
    opts.cache,
  );
  const expectedImpl = estimateImplementerCost(
    {
      taskCount,
      escalationRate: EXPECTED_ESCALATION_RATE,
      plannerTool,
      implementerTool,
      plannerModel,
      implementerModel,
    },
    opts.cache,
  );
  const highImpl = estimateImplementerCost(
    {
      taskCount,
      escalationRate: HIGH_ESCALATION_RATE,
      plannerTool,
      implementerTool,
      plannerModel,
      implementerModel,
    },
    opts.cache,
  );

  return {
    estimatedTasks: taskCount,
    lowCost: plannerCost + lowImpl,
    expectedCost: plannerCost + expectedImpl,
    highCost: plannerCost + highImpl,
    plannerTool,
    implementerTool,
  };
}
