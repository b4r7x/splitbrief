import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import type {
  BillingAttribution,
  CostBreakdown,
  OfferingBillingPresentation,
  ProviderRunMetadata,
} from '../../../core/schemas/summary.js';
import type { CallUsageEvidence } from '../../../core/schemas/usage-evidence.js';
import {
  API_PROVIDER_CATALOG,
  type ApiOffering,
} from '../../../core/providers/api-provider-catalog.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../../core/runners/cli-tool-catalog.js';
import { META_PROVIDER_IDS } from '../../../core/schemas/enums.js';
import {
  REMOVED_API_PROVIDER_IDS,
  REMOVED_CLI_TOOL_IDS,
  REMOVED_RUNNER_KINDS,
} from '../../../core/schemas/runner-fields.js';
import type { RunnerBillingPosture } from '../../../core/runners/runner-billing.js';
import { isReviewSeatCall } from '../../calls/review-seat.js';
import { normalizeProviderEndpoint } from '../../../core/providers/endpoint-policy.js';
import { splitSeatTokenTotals } from '../../../core/providers/seat-totals.js';
import { formatCost } from '../../../core/formatting.js';
import { resolvePricing, type ResolvedPricing } from '../pricing-resolver.js';
import type { ModelCacheAccessor } from '../model/resolution.js';
import {
  callRunnerName,
  deriveCallBilling,
  resolveCallPricing,
  sumRequestEstimates,
} from './request-estimates.js';
import {
  buildProviderUsageSegment,
  recordPricedUsage,
  recordProviderCost,
  resolveTaskPricingModel,
  type ProviderCostEntry,
  type ProviderUsageSegment,
} from '../cost-math.js';

type ResolveProviderRunMetadataOpts = {
  tool: string;
  normalizedEndpoint?: string | undefined;
};

// Meta seats and the identities this release removed carry no catalog
// descriptor. A resumed run still names them, so they must stay out of the
// custom-endpoint branch below rather than acquire an undated PAYG identity.
const DESCRIPTORLESS_TOOL_IDS = new Set<string>([
  ...META_PROVIDER_IDS,
  ...REMOVED_API_PROVIDER_IDS,
  ...REMOVED_CLI_TOOL_IDS,
  ...REMOVED_RUNNER_KINDS,
]);

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

/**
 * A catalog descriptor states what a tool bills by default. That is a product
 * fact, never evidence about one run's invocations, so metadata resolved from
 * the catalog alone carries no attribution until the run's own calls supply one.
 */
const UNATTRIBUTED_BILLING: BillingAttribution = { posture: 'unknown', basis: 'unknown' };
const LEGACY_BILLING: BillingAttribution = { posture: 'unknown', basis: 'legacy-unattributed' };

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
      billingAttribution: UNATTRIBUTED_BILLING,
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
      billingAttribution: UNATTRIBUTED_BILLING,
    };
  }

  if (DESCRIPTORLESS_TOOL_IDS.has(tool)) return undefined;

  // Anything left is a user-declared custom endpoint: metered per token, with no
  // catalog descriptor to date its identity against.
  return {
    service: tool,
    offering: 'payg',
    normalizedEndpoint: normalizedEndpoint ?? '',
    billing: 'api-metered',
    asOf: '',
    billingAttribution: UNATTRIBUTED_BILLING,
  };
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

function collectRunMetadataTools(opts: CostBreakdownOptions): string[] {
  if (opts.callEvidence !== undefined) {
    return [...new Set(opts.callEvidence.map(callRunnerName).filter((tool) => tool !== undefined))];
  }
  const tools = new Set<string>([opts.plannerTool, opts.implementerTool]);
  if (opts.reviewerTool !== undefined) tools.add(opts.reviewerTool);
  for (const task of opts.taskBreakdowns ?? []) {
    if (task.tool !== undefined) tools.add(task.tool);
  }
  return [...tools];
}

/**
 * What the run's own invocations proved about a tool's billing. Attributions
 * are compared whole — posture, basis and evidence id together — so one tool
 * reached through two different channels does not collapse into one claim: two
 * proven attributions that differ leave the tool unknown rather than letting
 * either of them stand for the run.
 */
function collectBillingEvidence(
  opts: CostBreakdownOptions,
  tools: readonly string[],
): Map<string, BillingAttribution> {
  const named = new Set(tools);
  const proven = new Map<string, BillingAttribution[]>();

  for (const call of opts.callEvidence ?? []) {
    const tool = callRunnerName(call);
    if (tool === undefined || !named.has(tool)) continue;
    const attribution = deriveCallBilling(call.invocationIdentity);
    const attributions = proven.get(tool) ?? [];
    if (!attributions.some((entry) => sameAttribution(entry, attribution))) {
      attributions.push(attribution);
    }
    proven.set(tool, attributions);
  }

  const evidence = new Map<string, BillingAttribution>();
  for (const [tool, attributions] of proven) {
    const [single] = attributions;
    evidence.set(tool, attributions.length === 1 && single ? single : UNATTRIBUTED_BILLING);
  }
  return evidence;
}

function sameAttribution(left: BillingAttribution, right: BillingAttribution): boolean {
  return (
    left.posture === right.posture &&
    left.basis === right.basis &&
    left.evidenceId === right.evidenceId
  );
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
  const tools = collectRunMetadataTools(opts);
  const billingEvidence = collectBillingEvidence(opts, tools);
  // A run that recorded no call identities at all carries no provenance to read,
  // which is what a record written before any of it was captured looks like.
  const unproven = opts.callEvidence === undefined ? LEGACY_BILLING : UNATTRIBUTED_BILLING;

  for (const tool of tools) {
    const descriptor = resolveProviderRunMetadata({ tool });
    if (descriptor === undefined) continue;
    const attribution = billingEvidence.get(tool);
    // Proof from the run's own invocations outranks the tool's catalogued
    // default, in both directions: an enforced api-key invocation is billed as
    // what it was, and channels that disagree are billed as unknown. A CLI
    // offering is a function of its billing, so it follows; there is no unknown
    // offering to move to, and payg's label reports the estimate or the word
    // `unknown` rather than claiming a subscription paid for the run.
    const billing = attribution === undefined ? descriptor.billing : attribution.posture;
    const metadata: ProviderRunMetadata = {
      ...descriptor,
      billing,
      ...(attribution !== undefined &&
        isCliToolId(tool) && { offering: cliOfferingFromBilling(billing) }),
      billingAttribution: attribution ?? unproven,
    };
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
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
  reviewerTool?: string | undefined;
  reviewerModel?: string | undefined;
  taskBreakdowns?: TaskTokenUsage[] | undefined;
  /**
   * Per-call usage records for this run. Present, they price every provider
   * request on its own; absent, the breakdown is the run-wide sum alone and
   * carries no request estimate.
   */
  callEvidence?: readonly CallUsageEvidence[] | undefined;
};

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
    const tool = callRunnerName(call);
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

type ImplementerCostAccounting = {
  actualImplementerCost: number;
  hasPricedUsage: boolean;
  hasUnpricedUsage: boolean;
  providerCosts: Record<string, ProviderCostEntry>;
};

function applyImplementerUsageSegment(
  accounting: ImplementerCostAccounting,
  segment: ProviderUsageSegment,
): void {
  if (segment.usageTokens <= 0) return;
  accounting.actualImplementerCost += segment.cost;
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

/**
 * Books each task's implementer spend against the provider that served it, from
 * the directional counters the task actually recorded. A record that carries a
 * combined count alone cannot say how much of it was input, so it is left
 * unattributed — its tokens stay with the run's own seat below and the run
 * reports an unpriced part rather than a share it never observed.
 */
function calculateTaskAwareImplementerCost(
  opts: CostBreakdownOptions,
  cache?: ModelCacheAccessor,
): ImplementerCostAccounting | undefined {
  const { taskBreakdowns, tokenUsage, implementerTool, implementerModel } = opts;
  if (taskBreakdowns === undefined) return undefined;

  const accounting: ImplementerCostAccounting = {
    actualImplementerCost: 0,
    hasPricedUsage: false,
    hasUnpricedUsage: false,
    providerCosts: {},
  };
  let accountedInputTokens = 0;
  let accountedOutputTokens = 0;
  let accountedCacheReadTokens = 0;
  let accountedCacheCreateTokens = 0;

  for (const task of taskBreakdowns) {
    const hasDirectionalSplit =
      task.implementerInputTokens !== undefined && task.implementerOutputTokens !== undefined;
    if (!hasDirectionalSplit && task.implementerTokens > 0) {
      accounting.hasUnpricedUsage = true;
      continue;
    }
    const tool = task.tool ?? implementerTool;
    const inputTokens = task.implementerInputTokens ?? 0;
    const cacheReadTokens = task.implementerCacheReadTokens ?? 0;
    const cacheCreateTokens = task.implementerCacheCreateTokens ?? 0;
    const generatedTokens =
      (task.implementerOutputTokens ?? 0) + (task.implementerReasoningTokens ?? 0);
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
        outputTokens: generatedTokens,
        cacheReadTokens,
        cacheCreateTokens,
      },
      cache,
    );
    accountedInputTokens += inputTokens;
    accountedOutputTokens += generatedTokens;
    accountedCacheReadTokens += cacheReadTokens;
    accountedCacheCreateTokens += cacheCreateTokens;
  }

  // What no task claimed is what the run's own seat spent: an exact remainder,
  // not a ratio.
  const residualInputTokens = Math.max(0, tokenUsage.implementerInput - accountedInputTokens);
  const residualOutputTokens = Math.max(0, tokenUsage.implementerOutput - accountedOutputTokens);
  const residualCacheReadTokens = Math.max(
    0,
    (tokenUsage.implementerCacheRead ?? 0) - accountedCacheReadTokens,
  );
  const residualCacheCreateTokens = Math.max(
    0,
    (tokenUsage.implementerCacheCreate ?? 0) - accountedCacheCreateTokens,
  );
  if (
    residualInputTokens > 0 ||
    residualOutputTokens > 0 ||
    residualCacheReadTokens > 0 ||
    residualCacheCreateTokens > 0
  ) {
    applyImplementerUsageCost(
      accounting,
      {
        tool: implementerTool,
        model: implementerModel,
        inputTokens: residualInputTokens,
        outputTokens: residualOutputTokens,
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
