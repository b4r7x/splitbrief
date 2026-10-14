import { z } from 'zod';
import { TaskTokenUsageSchema, TokenUsageSchema } from './tokens.js';
import { PhaseSchema, REVIEW_VERDICTS, RunnerKindSchema, WorkflowModeSchema } from './enums.js';
import { TaskIdSchema } from './task.js';
import { API_OFFERINGS } from '../providers/api-provider-catalog.js';
import { RunnerBillingPostureSchema } from '../runners/runner-billing.js';
import { RUNNER_CALL_ROLES } from '../runner-call-contract.js';
import { UsageBoundarySchema } from './usage-evidence.js';
import { InvocationIdentitySchema } from './invocation-identity.js';
import { uniqueInOrder } from '../../utils/collections.js';

export const BriefQualitySummarySchema = z.object({
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  errorCount: z.number().nonnegative(),
  warningCount: z.number().nonnegative(),
});

export const DriftSummarySchema = z.object({
  passed: z.boolean(),
  errorCount: z.number().nonnegative(),
  warningCount: z.number().nonnegative(),
});

export const ProviderCostSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cost: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheCreateTokens: z.number().nonnegative().optional(),
});

/**
 * How a billing posture was established. Only an enforced or observed channel
 * from the invocation itself, or proven local transport, is evidence: a tool's
 * catalogued default and a configured preference are not. A record written
 * before any of this was captured carries no provenance at all, which is
 * `legacy-unattributed` — an unattributed figure, never an invoice.
 */
export const BILLING_ATTRIBUTION_BASES = [
  'unknown',
  'enforced-channel',
  'observed-invocation',
  'local-transport',
  'legacy-unattributed',
] as const;
export const BillingAttributionSchema = z.object({
  posture: RunnerBillingPostureSchema,
  basis: z.enum(BILLING_ATTRIBUTION_BASES),
  evidenceId: z.string().min(1).optional(),
});
export type BillingAttribution = z.infer<typeof BillingAttributionSchema>;

const LEGACY_BILLING_ATTRIBUTION: BillingAttribution = {
  posture: 'unknown',
  basis: 'legacy-unattributed',
};

export const ProviderRunMetadataSchema = z.object({
  service: z.string(),
  offering: z.enum(API_OFFERINGS),
  normalizedEndpoint: z.string(),
  billing: RunnerBillingPostureSchema,
  asOf: z.string(),
  /**
   * What the run's own invocations proved about that billing posture. Absent on
   * a record written before any of it was captured, which is provenance nobody
   * has — `legacy-unattributed`, not a confirmed default.
   */
  billingAttribution: BillingAttributionSchema.optional(),
});

export const OfferingBillingPresentationSchema = z.object({
  costLabel: z.string(),
  billingLabel: z.string(),
});
export type ProviderRunMetadata = z.infer<typeof ProviderRunMetadataSchema>;
export type OfferingBillingPresentation = z.infer<typeof OfferingBillingPresentationSchema>;

/**
 * Why an estimate is less than a complete catalog price. Only the blocking ones
 * lower `completeness`; `reasoning-not-reported` records that a breakdown the
 * provider never sent cannot be displayed, which does not make the generated
 * total unpriceable.
 */
export const REQUEST_ESTIMATE_REASONS = [
  'usage-not-reported',
  'unpriced-model',
  'aggregate-boundary',
  'unknown-boundary',
  'unknown-context-total',
  'unknown-output-count',
  'unknown-input-count',
  'unknown-category-split',
  'missing-cache-rate',
  'reasoning-not-reported',
] as const;
export const RequestEstimateReasonSchema = z.enum(REQUEST_ESTIMATE_REASONS);

export const REQUEST_ESTIMATE_BASES = ['catalog-estimate', 'unavailable'] as const;
export const RequestEstimateBasisSchema = z.enum(REQUEST_ESTIMATE_BASES);

export const REQUEST_ESTIMATE_COMPLETENESS = ['complete', 'partial', 'unavailable'] as const;
export const RequestEstimateCompletenessSchema = z.enum(REQUEST_ESTIMATE_COMPLETENESS);

/**
 * One provider request, priced on its own. `amount` is the complete catalog
 * price and is `null` whenever any rate or counter it needs is unknown;
 * `knownSubtotal` is the part that could be priced, so an incomplete request
 * reports what is known instead of reporting an unknown as zero.
 */
/**
 * The rates one request was priced against, kept with the request so reopening
 * the record reports what it was priced at rather than what the catalog says
 * today. `capturedAt` is when those rates were looked up and says nothing about
 * when they were published; only `rateAsOf` does, and only when the source that
 * supplied them carries a date of its own.
 */
export const RateSnapshotSchema = z.object({
  source: z.enum(['models-dev', 'bundled-fallback', 'unpriced']),
  provider: z.string().min(1),
  model: z.string().min(1),
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
  cacheReadPer1M: z.number().nonnegative().optional(),
  cacheWritePer1M: z.number().nonnegative().optional(),
  selectedThresholdTokens: z.number().int().nonnegative().optional(),
  capturedAt: z.number().int().nonnegative(),
  rateAsOf: z.string().min(1).optional(),
});
export type RateSnapshot = z.infer<typeof RateSnapshotSchema>;

export const RequestEstimateItemSchema = z.object({
  callId: z.string().min(1),
  taskId: TaskIdSchema.optional(),
  attempt: z.number().int().nonnegative().optional(),
  role: z.enum(RUNNER_CALL_ROLES),
  model: z.string().min(1).optional(),
  usageBoundary: UsageBoundarySchema,
  amount: z.number().nonnegative().nullable(),
  knownSubtotal: z.number().nonnegative(),
  completeness: RequestEstimateCompletenessSchema,
  reasons: z.array(RequestEstimateReasonSchema),
  /** The rates this request was priced against, absent when none were resolved. */
  rates: RateSnapshotSchema.optional(),
  /** What this call proved about who paid for it. */
  billing: BillingAttributionSchema.default(LEGACY_BILLING_ATTRIBUTION),
  /** The call's own immutable identity, kept whole so two requests on one tool
   * through different auth, models or rates stay two requests. */
  invocationIdentity: InvocationIdentitySchema.optional(),
});

export const RequestEstimateSchema = z.object({
  amount: z.number().nonnegative().nullable(),
  currency: z.literal('USD'),
  basis: RequestEstimateBasisSchema,
  completeness: RequestEstimateCompletenessSchema,
  knownSubtotal: z.number().nonnegative(),
  reasons: z.array(RequestEstimateReasonSchema),
  items: z.array(RequestEstimateItemSchema),
});

export const CostBreakdownSchema = z.object({
  actualPlannerCost: z.number().nonnegative(),
  actualImplementerCost: z.number().nonnegative(),
  actualReviewerCost: z.number().nonnegative().optional(),
  totalActualCost: z.number().nonnegative(),
  hasPricedUsage: z.boolean().optional(),
  hasUnpricedUsage: z.boolean().optional(),
  isActualPlannerCostKnown: z.boolean().optional(),
  isActualImplementerCostKnown: z.boolean().optional(),
  isActualReviewerCostKnown: z.boolean().optional(),
  isTotalActualCostKnown: z.boolean().optional(),
  providerCosts: z.record(z.string(), ProviderCostSchema).optional(),
  /** Billing identity of every runner the run used, keyed by tool/provider id. */
  providerRunMetadata: z.record(z.string(), ProviderRunMetadataSchema).optional(),
  /** Offering-correct cost and billing labels for those runners. */
  offeringPresentations: z.record(z.string(), OfferingBillingPresentationSchema).optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  /**
   * Per-request catalog estimate. The numeric `actual*` fields above stay as
   * they are for readers written before this field existed; they are a run-wide
   * sum and cannot answer a request-tier question.
   */
  requestEstimate: RequestEstimateSchema.optional(),
});

export const CheckpointSummaryRollupSchema = z.object({
  count: z.number().int().nonnegative(),
  latestId: z.string().nullable(),
  latestName: z.string().nullable(),
  latestKind: z.string().nullable(),
  latestRunCheckpointId: z.string().nullable(),
  preFinalReviewId: z.string().nullable(),
  accepted: z.boolean().nullable(),
  rejected: z.boolean().nullable(),
});

export const ReviewFinalReviewStatusSchema = z.enum(['written', 'failed', 'missing', 'skipped']);

export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS);

export const ReviewFindingCountsSchema = z.object({
  critical: z.number().int().nonnegative(),
  warning: z.number().int().nonnegative(),
  note: z.number().int().nonnegative(),
});

export const ReviewFindingSeveritySchema = ReviewFindingCountsSchema.keyof();

export const ReviewPacketSummarySchema = z.object({
  jsonPath: z.string(),
  markdownPath: z.string(),
  generatedAt: z.string(),
  finalReviewStatus: ReviewFinalReviewStatusSchema,
  finalReviewVerdict: ReviewVerdictSchema.nullable().default(null),
  finalReviewFindingCounts: ReviewFindingCountsSchema.default({ critical: 0, warning: 0, note: 0 }),
  driftPassed: z.boolean().nullable(),
  evidenceValidatedTasks: z.number().int().nonnegative(),
  evidenceTotalTasks: z.number().int().nonnegative(),
  missingArtifactCount: z.number().int().nonnegative(),
});

export const SummarySchema = z.object({
  feature: z.string(),
  totalTasks: z.number().nonnegative(),
  completedByLocal: z.number().nonnegative(),
  escalatedToPlanner: z.number().nonnegative(),
  skipped: z.number().nonnegative(),
  failed: z.number().nonnegative(),
  totalTime: z.number().nonnegative(),
  tokenUsage: TokenUsageSchema,
  escalationRate: z.number().nonnegative(),
  taskBreakdown: z.array(TaskTokenUsageSchema).optional(),
  costBreakdown: CostBreakdownSchema.optional(),
  plannerTool: z.string().optional(),
  plannerModel: z.string().optional(),
  plannerKind: RunnerKindSchema.optional(),
  implementerTool: z.string().optional(),
  implementerModel: z.string().optional(),
  implementerKind: RunnerKindSchema.optional(),
  reviewerTool: z.string().optional(),
  reviewerModel: z.string().optional(),
  reviewerKind: RunnerKindSchema.optional(),
  phaseTimings: z.record(z.string(), z.number()).optional(),
  mode: WorkflowModeSchema.optional(),
  evidenceSummary: z
    .object({
      path: z.string(),
      totalTasks: z.number().nonnegative(),
      escalatedTasks: z.number().nonnegative(),
      failedTasks: z.number().nonnegative(),
      rejectionCount: z.number().nonnegative().optional(),
    })
    .optional(),
  briefQuality: BriefQualitySummarySchema.optional(),
  driftSummary: DriftSummarySchema.optional(),
  checkpointSummary: CheckpointSummaryRollupSchema.optional(),
  reviewPacket: ReviewPacketSummarySchema.optional(),
  review: z
    .object({
      verdict: ReviewVerdictSchema.nullable(),
      critical: z.number(),
      warnings: z.number(),
      notes: z.number(),
    })
    .optional(),
  changedFiles: z.array(z.string()).optional(),
  stoppedAt: z
    .object({
      taskId: TaskIdSchema,
      partialFiles: z.array(z.string()),
    })
    .optional(),
  phase: PhaseSchema.optional(),
});

export type BriefQualitySummary = z.infer<typeof BriefQualitySummarySchema>;
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;
export type RequestEstimate = z.infer<typeof RequestEstimateSchema>;
export type RequestEstimateItem = z.infer<typeof RequestEstimateItemSchema>;
export type RequestEstimateReason = z.infer<typeof RequestEstimateReasonSchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type ReviewPacketSummary = z.infer<typeof ReviewPacketSummarySchema>;

export interface CostKnownFlags {
  plannerCostKnown: boolean;
  implementerCostKnown: boolean;
  reviewerCostKnown?: boolean;
  totalCostKnown: boolean;
}

export function costKnownFlags(breakdown: CostBreakdown): CostKnownFlags {
  const plannerCostKnown =
    breakdown.isActualPlannerCostKnown ??
    !(breakdown.hasUnpricedUsage === true && breakdown.hasPricedUsage !== true);
  const implementerCostKnown =
    breakdown.isActualImplementerCostKnown ?? !(breakdown.hasUnpricedUsage === true);
  const totalCostKnown =
    breakdown.isTotalActualCostKnown ?? (plannerCostKnown && implementerCostKnown);
  return {
    plannerCostKnown,
    implementerCostKnown,
    ...(breakdown.isActualReviewerCostKnown !== undefined && {
      reviewerCostKnown: breakdown.isActualReviewerCostKnown,
    }),
    totalCostKnown,
  };
}

export const COST_AMOUNT_BASES = [
  'catalog-estimate',
  'unavailable',
  'legacy-unattributed',
] as const;
export const CostAmountBasisSchema = z.enum(COST_AMOUNT_BASES);
export type CostAmountBasis = z.infer<typeof CostAmountBasisSchema>;

/**
 * What a stored dollar figure is. A run that priced its requests carries the
 * estimate's own basis; a run whose breakdown predates per-request pricing
 * carries a sum with no provenance behind it, which is not an invoice and is
 * not a catalog estimate either.
 */
export function costAmountBasis(breakdown: CostBreakdown | undefined): CostAmountBasis {
  if (breakdown === undefined) return 'unavailable';
  return breakdown.requestEstimate?.basis ?? 'legacy-unattributed';
}

/**
 * The single cost label that describes a whole run, available only when every
 * runner it used bills outside per-token metering and they agree on one label.
 * A dollar figure would misreport those runs as a charge that never happened;
 * any metered runner makes the dollar figure the honest answer again.
 */
export function unmeteredRunCostLabel(breakdown: CostBreakdown): string | null {
  const items = breakdown.requestEstimate?.items;
  if (items === undefined || items.length === 0) return null;
  const labels: string[] = [];
  for (const { billing } of items) {
    if (billing.basis === 'unknown' || billing.basis === 'legacy-unattributed') return null;
    if (billing.posture !== 'local' && billing.posture !== 'subscription-included') return null;
    labels.push(billing.posture);
  }
  const unique = uniqueInOrder(labels);
  return unique.length === 0 ? null : unique.join(' · ');
}
