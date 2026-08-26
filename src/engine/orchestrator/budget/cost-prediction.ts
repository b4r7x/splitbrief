import type { TokenUsage } from '../../../core/schemas/tokens.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import type { Config } from '../../../core/schemas/config.js';
import { configuredReviewerSeat } from '../../../core/config/accessors/reviewer-seat.js';
import { splitSeatTokenTotals } from '../../../core/providers/seat-totals.js';
import { calculateCost, calculateUsageCost } from '../../providers/cost-math.js';
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
  config?: Config | undefined;
};

function estimateReviewerCost(opts: PredictCostOptions): number {
  const { tokenUsage } = opts;
  const seat = configuredReviewerSeat(opts.config);
  if (seat === undefined || tokenUsage === undefined) return 0;
  return calculateUsageCost({
    inputTokens: tokenUsage.reviewerInput,
    outputTokens: tokenUsage.reviewerOutput,
    cacheReadTokens: tokenUsage.reviewerCacheRead ?? 0,
    cacheCreateTokens: tokenUsage.reviewerCacheCreate ?? 0,
    pricing: resolvePricing(seat.tool, opts.cache, seat.model),
  });
}

function estimatePlannerCost(opts: PredictCostOptions): number {
  const { taskCount, plannerTool, plannerModel, tokenUsage } = opts;
  const plannerPricing = resolvePricing(plannerTool, opts.cache, plannerModel);

  if (tokenUsage) {
    const planner = splitSeatTokenTotals({
      tokenUsage,
      reviewerTool: configuredReviewerSeat(opts.config)?.tool,
    }).planner;
    if (planner.input > 0 || planner.output > 0) {
      return calculateUsageCost({
        inputTokens: planner.input,
        outputTokens: planner.output,
        cacheReadTokens: planner.cacheRead,
        cacheCreateTokens: planner.cacheCreate,
        pricing: plannerPricing,
      });
    }
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

  const plannerCost = estimatePlannerCost(opts) + estimateReviewerCost(opts);

  const implementerCostAt = (escalationRate: number): number =>
    estimateImplementerCost(
      {
        taskCount,
        escalationRate,
        plannerTool,
        implementerTool,
        plannerModel,
        implementerModel,
      },
      opts.cache,
    );

  const lowImpl = implementerCostAt(LOW_ESCALATION_RATE);
  const expectedImpl = implementerCostAt(EXPECTED_ESCALATION_RATE);
  const highImpl = implementerCostAt(HIGH_ESCALATION_RATE);

  return {
    estimatedTasks: taskCount,
    lowCost: plannerCost + lowImpl,
    expectedCost: plannerCost + expectedImpl,
    highCost: plannerCost + highImpl,
    plannerTool,
    implementerTool,
  };
}
