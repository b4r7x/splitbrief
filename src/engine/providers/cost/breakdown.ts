import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import type {
  CostBreakdown,
  OfferingBillingPresentation,
  ProviderRunMetadata,
} from '../../../core/schemas/summary.js';
import {
  API_PROVIDER_CATALOG,
  type ApiOffering,
} from '../../../core/providers/api-provider-catalog.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import type { RunnerBillingPosture } from '../../../core/runners/runner-billing.js';
import { normalizeProviderEndpoint } from '../../../core/providers/endpoint-policy.js';
import { splitSeatTokenTotals } from '../../../core/providers/seat-totals.js';
import { formatCost, formatCostFact } from '../../../core/formatting.js';
import { resolvePricing, type ResolvedPricing } from '../pricing-resolver.js';
import type { ModelCacheAccessor } from '../model/resolution.js';
import {
  allocatedCacheTokens,
  buildProviderUsageSegment,
  calculateCacheReadSavings,
  recordPricedUsage,
  recordProviderCost,
  resolveTaskPricingModel,
  splitTokens,
  type ProviderCostEntry,
  type ProviderUsageSegment,
} from '../cost-math.js';

type ResolveProviderRunMetadataOpts = {
  tool: string;
  normalizedEndpoint?: string | undefined;
};

function isApiProviderId(tool: string): tool is keyof typeof API_PROVIDER_CATALOG {
  return Object.hasOwn(API_PROVIDER_CATALOG, tool);
}

function isCliToolId(tool: string): tool is CliToolId {
  return Object.hasOwn(CLI_TOOL_CATALOG, tool);
}

function cliOfferingFromBilling(billing: RunnerBillingPosture): ApiOffering {
  if (billing === 'local') return 'local';
  if (billing === 'subscription-included') return 'coding-subscription';
  return 'payg';
}

function defaultEndpointForApiProvider(providerId: keyof typeof API_PROVIDER_CATALOG): string {
  const policy = API_PROVIDER_CATALOG[providerId].endpointPolicy;
  if (policy.kind === 'fixed-origin') return policy.baseURL;
  if (policy.kind === 'loopback') return policy.defaultBaseURL;
  return '';
}

export function resolveProviderRunMetadata(
  opts: ResolveProviderRunMetadataOpts,
): ProviderRunMetadata | undefined {
  const { tool, normalizedEndpoint } = opts;

  if (isApiProviderId(tool)) {
    const descriptor = API_PROVIDER_CATALOG[tool];
    const endpointInput = normalizedEndpoint ?? defaultEndpointForApiProvider(tool);
    const resolvedEndpoint =
      endpointInput.length > 0
        ? normalizeProviderEndpoint(descriptor.endpointPolicy, endpointInput)
        : '';
    return {
      service: descriptor.service,
      offering: descriptor.offering,
      normalizedEndpoint: resolvedEndpoint,
      billing: descriptor.billing,
      asOf: descriptor.asOf,
    };
  }

  if (isCliToolId(tool)) {
    const descriptor = CLI_TOOL_CATALOG[tool];
    return {
      service: descriptor.id,
      offering: cliOfferingFromBilling(descriptor.billing),
      normalizedEndpoint: `cli:${descriptor.command}`,
      billing: descriptor.billing,
      asOf: descriptor.compatibility.evidence.asOf,
    };
  }

  return undefined;
}

export function describeOfferingBillingPresentation(
  metadata: ProviderRunMetadata,
  opts?: { hasUsage?: boolean | undefined; meteredCost?: number | undefined },
): OfferingBillingPresentation {
  const hasUsage = opts?.hasUsage ?? false;
  const meteredCost = opts?.meteredCost ?? 0;

  switch (metadata.offering) {
    case 'payg':
      return {
        costLabel: hasUsage ? formatCost(meteredCost) : metadata.billing,
        billingLabel: metadata.billing,
      };
    case 'coding-subscription':
      return {
        costLabel: 'subscription-included',
        billingLabel: 'subscription-included',
      };
    case 'free-quota':
      return {
        costLabel: 'variable quota',
        billingLabel: metadata.billing,
      };
    case 'local':
      return {
        costLabel: 'local',
        billingLabel: 'local',
      };
  }
}

export function formatOfferingAwareExtraCost(
  metadata: ProviderRunMetadata,
  extraAmount: number,
): string | null {
  if (metadata.offering === 'coding-subscription') return null;
  if (!Number.isFinite(extraAmount) || extraAmount <= 0) return null;
  return `Extra ${formatCostFact(extraAmount)}`;
}

function collectRunMetadataTools(opts: CostBreakdownOptions): string[] {
  const tools = new Set<string>([opts.plannerTool, opts.implementerTool]);
  if (opts.reviewerTool !== undefined) tools.add(opts.reviewerTool);
  for (const task of opts.taskBreakdowns ?? []) {
    if (task.tool !== undefined) tools.add(task.tool);
  }
  return [...tools];
}

function buildProviderRunMetadataRecord(
  opts: CostBreakdownOptions,
  providerCosts: Record<string, ProviderCostEntry> | undefined,
): {
  providerRunMetadata: Record<string, ProviderRunMetadata>;
  offeringPresentations: Record<string, OfferingBillingPresentation>;
} {
  const providerRunMetadata: Record<string, ProviderRunMetadata> = {};
  const offeringPresentations: Record<string, OfferingBillingPresentation> = {};

  for (const tool of collectRunMetadataTools(opts)) {
    const metadata = resolveProviderRunMetadata({ tool });
    if (metadata === undefined) continue;
    providerRunMetadata[tool] = metadata;
    const usageEntry = providerCosts?.[tool];
    const usageTokens =
      (usageEntry?.inputTokens ?? 0) +
      (usageEntry?.outputTokens ?? 0) +
      (usageEntry?.cacheReadTokens ?? 0) +
      (usageEntry?.cacheCreateTokens ?? 0);
    offeringPresentations[tool] = describeOfferingBillingPresentation(metadata, {
      hasUsage: usageTokens > 0,
      meteredCost: usageEntry?.cost ?? 0,
    });
  }

  return { providerRunMetadata, offeringPresentations };
}

type CostBreakdownOptions = {
  tokenUsage: TokenUsage;
  totalTasks: number;
  escalatedCount: number;
  completedLocalTasks?: number | undefined;
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
  reviewerTool?: string | undefined;
  reviewerModel?: string | undefined;
  taskBreakdowns?: TaskTokenUsage[] | undefined;
};

type ImplementerCostAccounting = {
  actualImplementerCost: number;
  hasPricedUsage: boolean;
  hasUnpricedUsage: boolean;
  providerCosts: Record<string, ProviderCostEntry>;
  cacheReadSavings: number;
};

function applyImplementerUsageSegment(
  accounting: ImplementerCostAccounting,
  segment: ProviderUsageSegment,
): void {
  if (segment.usageTokens <= 0) return;
  accounting.actualImplementerCost += segment.cost;
  accounting.cacheReadSavings += calculateCacheReadSavings(
    segment.cacheReadTokens,
    segment.pricing,
    segment.contextTokens,
  );
  if (segment.pricing.isPriced) {
    accounting.hasPricedUsage = true;
  }
  if (!segment.costKnown) {
    accounting.hasUnpricedUsage = true;
  }
  recordPricedUsage(accounting.providerCosts, segment);
}

function applyImplementerUsageCost(
  accounting: ImplementerCostAccounting,
  opts: {
    tool: string;
    model?: string | undefined;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  },
  cache?: ModelCacheAccessor,
): void {
  const pricing = resolvePricing(opts.tool, cache, opts.model);
  applyImplementerUsageSegment(
    accounting,
    buildProviderUsageSegment({
      tool: opts.tool,
      model: opts.model,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      cacheReadTokens: opts.cacheReadTokens,
      cacheCreateTokens: opts.cacheCreateTokens,
      pricing,
    }),
  );
}

function calculateAggregateImplementerCost(
  opts: CostBreakdownOptions,
  pricing: ResolvedPricing,
): ImplementerCostAccounting {
  const { tokenUsage, implementerTool } = opts;
  const accounting: ImplementerCostAccounting = {
    actualImplementerCost: 0,
    hasPricedUsage: false,
    hasUnpricedUsage: false,
    providerCosts: {},
    cacheReadSavings: 0,
  };
  applyImplementerUsageSegment(
    accounting,
    buildProviderUsageSegment({
      tool: implementerTool,
      model: opts.implementerModel,
      inputTokens: tokenUsage.implementerInput,
      outputTokens: tokenUsage.implementerOutput,
      cacheReadTokens: tokenUsage.implementerCacheRead ?? 0,
      cacheCreateTokens: tokenUsage.implementerCacheCreate ?? 0,
      pricing,
    }),
  );
  return accounting;
}

function calculateTaskAwareImplementerCost(
  opts: CostBreakdownOptions,
  cache?: ModelCacheAccessor,
): ImplementerCostAccounting | undefined {
  const { taskBreakdowns, tokenUsage, implementerTool, implementerModel } = opts;
  if (taskBreakdowns === undefined) return undefined;

  const totalImplementerTokens = tokenUsage.implementerInput + tokenUsage.implementerOutput;
  const accounting: ImplementerCostAccounting = {
    actualImplementerCost: 0,
    hasPricedUsage: false,
    hasUnpricedUsage: false,
    providerCosts: {},
    cacheReadSavings: 0,
  };
  let accountedTokens = 0;
  let accountedCacheReadTokens = 0;
  let accountedCacheCreateTokens = 0;

  for (const task of taskBreakdowns) {
    const tool = task.tool ?? implementerTool;
    const { inputTokens, outputTokens } = splitTokens({
      tokens: task.implementerTokens,
      inputTotal: tokenUsage.implementerInput,
      outputTotal: tokenUsage.implementerOutput,
    });
    const cacheReadTokens =
      task.implementerCacheReadTokens ??
      allocatedCacheTokens({
        cacheTokens: tokenUsage.implementerCacheRead,
        tokens: task.implementerTokens,
        totalTokens: totalImplementerTokens,
      });
    const cacheCreateTokens =
      task.implementerCacheCreateTokens ??
      allocatedCacheTokens({
        cacheTokens: tokenUsage.implementerCacheCreate,
        tokens: task.implementerTokens,
        totalTokens: totalImplementerTokens,
      });
    applyImplementerUsageCost(
      accounting,
      {
        tool,
        model: resolveTaskPricingModel({
          taskTool: tool,
          fallbackTool: implementerTool,
          taskModel: task.model,
          fallbackModel: implementerModel,
        }),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreateTokens,
      },
      cache,
    );
    accountedTokens += task.implementerTokens;
    accountedCacheReadTokens += cacheReadTokens;
    accountedCacheCreateTokens += cacheCreateTokens;
  }

  const residualTokens = Math.max(0, totalImplementerTokens - accountedTokens);
  const residualCacheReadTokens = Math.max(
    0,
    (tokenUsage.implementerCacheRead ?? 0) - accountedCacheReadTokens,
  );
  const residualCacheCreateTokens = Math.max(
    0,
    (tokenUsage.implementerCacheCreate ?? 0) - accountedCacheCreateTokens,
  );
  if (residualTokens > 0 || residualCacheReadTokens > 0 || residualCacheCreateTokens > 0) {
    const { inputTokens, outputTokens } = splitTokens({
      tokens: residualTokens,
      inputTotal: tokenUsage.implementerInput,
      outputTotal: tokenUsage.implementerOutput,
    });
    applyImplementerUsageCost(
      accounting,
      {
        tool: implementerTool,
        model: implementerModel,
        inputTokens,
        outputTokens,
        cacheReadTokens: residualCacheReadTokens,
        cacheCreateTokens: residualCacheCreateTokens,
      },
      cache,
    );
  }

  return accounting;
}

export function calculateCostBreakdown(
  opts: CostBreakdownOptions,
  cache?: ModelCacheAccessor,
): CostBreakdown {
  const { tokenUsage, totalTasks, escalatedCount, completedLocalTasks, plannerTool, plannerModel } =
    opts;
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
  const hypotheticalImplementerSegment = buildProviderUsageSegment({
    tool: plannerTool,
    model: plannerModel,
    inputTokens: tokenUsage.implementerInput,
    outputTokens: tokenUsage.implementerOutput,
    cacheReadTokens: tokenUsage.implementerCacheRead ?? 0,
    cacheCreateTokens: tokenUsage.implementerCacheCreate ?? 0,
    pricing: plannerPricing,
  });
  const hypotheticalImplementerCost = hypotheticalImplementerSegment.cost;
  const isHypotheticalImplementerCostKnown =
    implementerUsageTokens <= 0 || hypotheticalImplementerSegment.costKnown;
  const hypotheticalReviewerSegment =
    reviewerSegment === undefined
      ? undefined
      : buildProviderUsageSegment({
          tool: plannerTool,
          model: plannerModel,
          inputTokens: reviewerSegment.inputTokens,
          outputTokens: reviewerSegment.outputTokens,
          cacheReadTokens: reviewerSegment.cacheReadTokens,
          cacheCreateTokens: reviewerSegment.cacheCreateTokens,
          pricing: plannerPricing,
        });
  const isHypotheticalReviewerCostKnown =
    hypotheticalReviewerSegment === undefined ||
    hypotheticalReviewerSegment.usageTokens <= 0 ||
    hypotheticalReviewerSegment.costKnown;
  const isAllPlannerBaselineKnown =
    isActualPlannerCostKnown &&
    isHypotheticalImplementerCostKnown &&
    isHypotheticalReviewerCostKnown;
  const hypotheticalCost = isAllPlannerBaselineKnown
    ? actualPlannerCost + hypotheticalImplementerCost + (hypotheticalReviewerSegment?.cost ?? 0)
    : 0;
  const hasSavingsEstimate = isAllPlannerBaselineKnown && isTotalActualCostKnown;
  const savingsAmount = hasSavingsEstimate ? hypotheticalCost - totalActualCost : 0;
  const savingsPercentage =
    hasSavingsEstimate && hypotheticalCost > 0 ? (savingsAmount / hypotheticalCost) * 100 : 0;
  const localSuccesses = completedLocalTasks ?? Math.max(0, totalTasks - escalatedCount);
  const localCompletionRate = totalTasks > 0 ? localSuccesses / totalTasks : 0;
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

  let cacheReadSavings = 0;
  if (cacheReadTokens > 0) {
    cacheReadSavings += calculateCacheReadSavings(
      plannerTotals.cacheRead,
      plannerPricing,
      plannerSegment.contextTokens,
    );
    cacheReadSavings += implementerAccounting.cacheReadSavings;
    if (reviewerSegment !== undefined) {
      cacheReadSavings += calculateCacheReadSavings(
        reviewerSegment.cacheReadTokens,
        reviewerSegment.pricing,
        reviewerSegment.contextTokens,
      );
    }
  }

  const { providerRunMetadata, offeringPresentations } = buildProviderRunMetadataRecord(
    opts,
    Object.keys(providerCosts).length > 0 ? providerCosts : undefined,
  );

  return {
    hypotheticalCost,
    actualPlannerCost,
    actualImplementerCost,
    totalActualCost,
    savingsAmount,
    savingsPercentage,
    localCompletionRate,
    hasPricedUsage,
    hasUnpricedUsage,
    hasSavingsEstimate,
    isActualPlannerCostKnown,
    isActualImplementerCostKnown,
    ...(reviewerSegment !== undefined && { actualReviewerCost, isActualReviewerCostKnown }),
    isTotalActualCostKnown,
    isAllPlannerBaselineKnown,
    providerCosts: Object.keys(providerCosts).length > 0 ? providerCosts : undefined,
    ...(Object.keys(providerRunMetadata).length > 0 && { providerRunMetadata }),
    ...(Object.keys(offeringPresentations).length > 0 && { offeringPresentations }),
    ...(cacheReadSavings > 0 && { cacheReadSavings }),
    ...(cacheReadTokens > 0 && { cacheReadTokens }),
    ...(cacheWriteTokens > 0 && { cacheWriteTokens }),
  };
}
