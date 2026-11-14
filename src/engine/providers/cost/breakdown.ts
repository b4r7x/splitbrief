import type { CostBreakdown } from '../../../core/schemas/cost.js';
import type { CallUsageEvidence } from '../../../core/schemas/usage-evidence.js';
import { isReviewSeatCall } from '../../calls/review-seat.js';
import { splitSeatTokenTotals } from '../../../core/providers/seat-totals.js';
import { resolvePricing } from './pricing.js';
import type { ModelCacheAccessor } from '../model/runtime-snapshot.js';
import { callRunnerKey, resolveCallPricing, sumRequestEstimates } from './request-estimates.js';
import {
  buildProviderUsageSegment,
  recordPricedUsage,
  recordProviderCost,
  type ProviderCostEntry,
} from './math.js';
import { buildProviderRunMetadataRecord } from './run-record.js';
import {
  calculateTaskAwareImplementerCost,
  calculateAggregateImplementerCost,
} from './implementer.js';
import type { CostBreakdownOptions } from './types.js';

function calculateRecordedCostBreakdown(
  opts: CostBreakdownOptions,
  evidence: readonly CallUsageEvidence[],
  cache: ModelCacheAccessor | undefined,
): CostBreakdown {
  // Planning-time review checks are booked against PLAN. Apply that rule at the shared pricing
  // boundary so live and persisted evidence produce the same request roles.
  const pricedEvidence = evidence.map((call) => {
    if (call.role !== 'review' || isReviewSeatCall({ role: call.role, phase: call.phase })) {
      return call;
    }
    return { ...call, role: 'planner' as const };
  });
  const requestEstimate = sumRequestEstimates(pricedEvidence, (call) =>
    resolveCallPricing(call, cache),
  );
  const providerCosts: Record<string, ProviderCostEntry> = {};
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const [index, call] of pricedEvidence.entries()) {
    const tool = callRunnerKey(call);
    const usage = call.usage;
    if (usage === null) continue;
    cacheReadTokens += usage.cacheReadTokens ?? 0;
    cacheWriteTokens += usage.cacheCreateTokens ?? 0;
    if (tool === undefined) continue;
    recordProviderCost(providerCosts, {
      tool,
      inputTokens: usage.inputTokens,
      outputTokens:
        usage.providerTotals?.output ?? usage.outputTokens + (usage.reasoningTokens ?? 0),
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheCreateTokens: usage.cacheCreateTokens ?? 0,
      cost: requestEstimate.items[index]?.knownSubtotal ?? 0,
    });
  }
  const plannerItems = requestEstimate.items.filter(
    (item) => item.role !== 'implementer' && item.role !== 'review',
  );
  const implementerItems = requestEstimate.items.filter((item) => item.role === 'implementer');
  const reviewerItems = requestEstimate.items.filter((item) => item.role === 'review');
  return {
    actualPlannerCost: plannerItems.reduce((sum, item) => sum + item.knownSubtotal, 0),
    actualImplementerCost: implementerItems.reduce((sum, item) => sum + item.knownSubtotal, 0),
    totalActualCost: requestEstimate.knownSubtotal,
    hasPricedUsage: requestEstimate.items.some((item) => item.completeness !== 'unavailable'),
    hasUnpricedUsage: requestEstimate.items.some((item) => item.completeness !== 'complete'),
    isActualPlannerCostKnown: plannerItems.every((item) => item.completeness === 'complete'),
    isActualImplementerCostKnown: implementerItems.every(
      (item) => item.completeness === 'complete',
    ),
    ...(reviewerItems.length > 0 && {
      actualReviewerCost: reviewerItems.reduce((sum, item) => sum + item.knownSubtotal, 0),
      isActualReviewerCostKnown: reviewerItems.every((item) => item.completeness === 'complete'),
    }),
    isTotalActualCostKnown: requestEstimate.completeness === 'complete',
    providerCosts,
    ...buildProviderRunMetadataRecord(opts, providerCosts),
    ...(cacheReadTokens > 0 && { cacheReadTokens }),
    ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
    requestEstimate,
  };
}

export function calculateCostBreakdown(
  opts: CostBreakdownOptions,
  cache?: ModelCacheAccessor,
): CostBreakdown {
  if (opts.callEvidence !== undefined) {
    return calculateRecordedCostBreakdown(opts, opts.callEvidence, cache);
  }
  const { tokenUsage, plannerTool, plannerModel } = opts;
  const plannerPricing = resolvePricing(plannerTool, cache, plannerModel);
  const implementerPricing = resolvePricing(opts.implementerTool, cache, opts.implementerModel);
  const reviewerTool = opts.reviewerTool;
  const seats = splitSeatTokenTotals({ tokenUsage, reviewerTool });
  const plannerTotals = seats.planner;

  const plannerSegment = buildProviderUsageSegment({
    tool: plannerTool,
    model: plannerModel,
    inputTokens: plannerTotals.input,
    outputTokens: plannerTotals.output,
    cacheReadTokens: plannerTotals.cacheRead,
    cacheCreateTokens: plannerTotals.cacheCreate,
    pricing: plannerPricing,
  });
  const actualPlannerCost = plannerSegment.cost;

  const reviewerSegment =
    reviewerTool === undefined || seats.reviewer === undefined
      ? undefined
      : buildProviderUsageSegment({
          tool: reviewerTool,
          model: opts.reviewerModel,
          inputTokens: seats.reviewer.input,
          outputTokens: seats.reviewer.output,
          cacheReadTokens: seats.reviewer.cacheRead,
          cacheCreateTokens: seats.reviewer.cacheCreate,
          pricing: resolvePricing(reviewerTool, cache, opts.reviewerModel),
        });
  const actualReviewerCost = reviewerSegment?.cost ?? 0;

  const implementerAccounting =
    calculateTaskAwareImplementerCost(opts, cache) ??
    calculateAggregateImplementerCost(opts, implementerPricing);
  const actualImplementerCost = implementerAccounting.actualImplementerCost;

  const totalActualCost = actualPlannerCost + actualImplementerCost + actualReviewerCost;
  const plannerUsageTokens =
    plannerTotals.input +
    plannerTotals.output +
    plannerTotals.cacheRead +
    plannerTotals.cacheCreate;
  const implementerUsageTokens =
    tokenUsage.implementerInput +
    tokenUsage.implementerOutput +
    (tokenUsage.implementerCacheRead ?? 0) +
    (tokenUsage.implementerCacheCreate ?? 0);
  const isActualPlannerCostKnown = plannerUsageTokens <= 0 || plannerSegment.costKnown;
  const isActualImplementerCostKnown =
    implementerUsageTokens <= 0 || !implementerAccounting.hasUnpricedUsage;
  const isActualReviewerCostKnown =
    reviewerSegment === undefined || reviewerSegment.usageTokens <= 0 || reviewerSegment.costKnown;
  const isTotalActualCostKnown =
    isActualPlannerCostKnown && isActualImplementerCostKnown && isActualReviewerCostKnown;
  const hasPricedUsage =
    (plannerSegment.usageTokens > 0 && plannerPricing.isPriced) ||
    implementerAccounting.hasPricedUsage ||
    (reviewerSegment !== undefined &&
      reviewerSegment.usageTokens > 0 &&
      reviewerSegment.pricing.isPriced);
  const hasUnpricedUsage =
    (plannerSegment.usageTokens > 0 && !plannerSegment.costKnown) ||
    implementerAccounting.hasUnpricedUsage ||
    (reviewerSegment !== undefined &&
      reviewerSegment.usageTokens > 0 &&
      !reviewerSegment.costKnown);

  const providerCosts: Record<string, ProviderCostEntry> = {};
  recordPricedUsage(providerCosts, plannerSegment);
  if (reviewerSegment !== undefined) recordPricedUsage(providerCosts, reviewerSegment);
  for (const [tool, entry] of Object.entries(implementerAccounting.providerCosts)) {
    recordProviderCost(providerCosts, {
      tool,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheCreateTokens: entry.cacheCreateTokens,
      cost: entry.cost,
    });
  }

  const cacheReadTokens =
    plannerTotals.cacheRead +
    (tokenUsage.implementerCacheRead ?? 0) +
    (reviewerSegment?.cacheReadTokens ?? 0);
  const cacheWriteTokens =
    plannerTotals.cacheCreate +
    (tokenUsage.implementerCacheCreate ?? 0) +
    (reviewerSegment?.cacheCreateTokens ?? 0);

  const { providerRunMetadata, offeringPresentations } = buildProviderRunMetadataRecord(
    opts,
    Object.keys(providerCosts).length > 0 ? providerCosts : undefined,
  );

  return {
    actualPlannerCost,
    actualImplementerCost,
    totalActualCost,
    hasPricedUsage,
    hasUnpricedUsage,
    isActualPlannerCostKnown,
    isActualImplementerCostKnown,
    ...(reviewerSegment !== undefined && { actualReviewerCost, isActualReviewerCostKnown }),
    isTotalActualCostKnown,
    providerCosts: Object.keys(providerCosts).length > 0 ? providerCosts : undefined,
    ...(Object.keys(providerRunMetadata).length > 0 && { providerRunMetadata }),
    ...(Object.keys(offeringPresentations).length > 0 && { offeringPresentations }),
    ...(cacheReadTokens > 0 && { cacheReadTokens }),
    ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
  };
}
