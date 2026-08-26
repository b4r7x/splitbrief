import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import { splitSeatTokenTotals } from '../../../core/providers/seat-totals.js';
import { resolvePricing } from '../pricing-resolver.js';
import type { ModelCacheAccessor } from '../model/resolution.js';
import {
  allocatedCacheTokens,
  buildProviderUsageSegment,
  resolveTaskPricingModel,
  splitTokens,
  type ProviderUsageSegment,
} from '../cost-math.js';

export interface CalculateTaskUsageCostOptions {
  task: TaskTokenUsage;
  tokenUsage: TokenUsage;
  implementerTool: string;
  plannerTool: string;
  implementerModel?: string | undefined;
  plannerModel?: string | undefined;
  reviewerTool?: string | undefined;
  cache?: ModelCacheAccessor | undefined;
}

function buildTaskImplementerSegment(options: CalculateTaskUsageCostOptions): ProviderUsageSegment {
  const { task, tokenUsage, implementerTool, implementerModel, cache } = options;
  const totalImplementerTokens = tokenUsage.implementerInput + tokenUsage.implementerOutput;
  const implementerSplit = splitTokens({
    tokens: task.implementerTokens,
    inputTotal: tokenUsage.implementerInput,
    outputTotal: tokenUsage.implementerOutput,
  });
  const taskTool = task.tool ?? implementerTool;
  const pricingModel = resolveTaskPricingModel({
    taskTool,
    fallbackTool: implementerTool,
    taskModel: task.model,
    fallbackModel: implementerModel,
  });
  const implementerPricing = resolvePricing(taskTool, cache, pricingModel);
  const implementerCacheRead =
    task.implementerCacheReadTokens ??
    allocatedCacheTokens({
      cacheTokens: tokenUsage.implementerCacheRead,
      tokens: task.implementerTokens,
      totalTokens: totalImplementerTokens,
    });
  const implementerCacheCreate =
    task.implementerCacheCreateTokens ??
    allocatedCacheTokens({
      cacheTokens: tokenUsage.implementerCacheCreate,
      tokens: task.implementerTokens,
      totalTokens: totalImplementerTokens,
    });
  return buildProviderUsageSegment({
    tool: taskTool,
    model: pricingModel,
    inputTokens: implementerSplit.inputTokens,
    outputTokens: implementerSplit.outputTokens,
    primaryTokens: task.implementerTokens,
    cacheReadTokens: implementerCacheRead,
    cacheCreateTokens: implementerCacheCreate,
    pricing: implementerPricing,
  });
}

function buildTaskEscalationSegment(options: CalculateTaskUsageCostOptions): ProviderUsageSegment {
  const { task, tokenUsage, plannerTool, plannerModel, cache, reviewerTool } = options;
  const plannerSeat = splitSeatTokenTotals({ tokenUsage, reviewerTool }).planner;
  const escalationSplit = splitTokens({
    tokens: task.escalationTokens,
    inputTotal: tokenUsage.escalationInput,
    outputTotal: tokenUsage.escalationOutput,
  });
  const plannerSeatTokens = plannerSeat.input + plannerSeat.output;
  const plannerPricing = resolvePricing(plannerTool, cache, plannerModel);
  const escalationCacheRead =
    task.escalationCacheReadTokens ??
    allocatedCacheTokens({
      cacheTokens: plannerSeat.cacheRead,
      tokens: task.escalationTokens,
      totalTokens: plannerSeatTokens,
    });
  const escalationCacheCreate =
    task.escalationCacheCreateTokens ??
    allocatedCacheTokens({
      cacheTokens: plannerSeat.cacheCreate,
      tokens: task.escalationTokens,
      totalTokens: plannerSeatTokens,
    });
  return buildProviderUsageSegment({
    tool: plannerTool,
    model: plannerModel,
    inputTokens: escalationSplit.inputTokens,
    outputTokens: escalationSplit.outputTokens,
    primaryTokens: task.escalationTokens,
    cacheReadTokens: escalationCacheRead,
    cacheCreateTokens: escalationCacheCreate,
    pricing: plannerPricing,
  });
}

export function calculateTaskUsageCost(options: CalculateTaskUsageCostOptions): number {
  const implementerSegment = buildTaskImplementerSegment(options);
  const escalationSegment = buildTaskEscalationSegment(options);

  return implementerSegment.cost + escalationSegment.cost;
}

export function isTaskUsageCostKnown(options: CalculateTaskUsageCostOptions): boolean {
  const implementerSegment = buildTaskImplementerSegment(options);
  const escalationSegment = buildTaskEscalationSegment(options);
  const implementerKnown = implementerSegment.usageTokens <= 0 || implementerSegment.costKnown;
  const plannerKnown = escalationSegment.usageTokens <= 0 || escalationSegment.costKnown;
  return implementerKnown && plannerKnown;
}
