import { z } from 'zod';
import { TaskTokenUsageSchema, TokenUsageSchema } from './tokens.js';
import { TASK_CONTEXT_FITS, WorkflowModeSchema } from './enums.js';
import { TaskIdSchema } from './task.js';
import { API_OFFERINGS, type ApiOffering } from '../providers/api-provider-catalog.js';
import { RunnerBillingPostureSchema } from '../runners/runner-billing.js';

export const ESTIMATE_CONTEXT_CONFIDENCES = [
  'context-explicit',
  'context-detected',
  'context-known-catalog',
  'context-cached-provider',
  'context-conservative-fallback',
  'profile-unavailable',
] as const;
export const EstimateContextConfidenceSchema = z.enum(ESTIMATE_CONTEXT_CONFIDENCES);

export const ESTIMATE_PRICE_CONFIDENCES = [
  'price-known',
  'price-unknown',
  'profile-unavailable',
] as const;
export const EstimatePriceConfidenceSchema = z.enum(ESTIMATE_PRICE_CONFIDENCES);

export const ESTIMATE_UNKNOWN_COST_REASONS = [
  'implementer-price-unknown',
  'planner-price-unknown',
  'profile-unavailable',
] as const;
export const EstimateUnknownCostReasonSchema = z.enum(ESTIMATE_UNKNOWN_COST_REASONS);

export const ChainDriftSummarySchema = z.object({
  score: z.number().min(0).max(1),
  chainLength: z.number().int().nonnegative(),
  uniqueOutOfBoundsFiles: z.array(z.string()),
  representativePath: z.string(),
  emittedChainCount: z.number().int().nonnegative(),
});

export const BriefQualitySummarySchema = z.object({
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  errorCount: z.number().nonnegative(),
  warningCount: z.number().nonnegative(),
});

export const DriftSummarySchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(1),
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

export const ProviderRunMetadataSchema = z.object({
  service: z.string(),
  offering: z.enum(API_OFFERINGS),
  normalizedEndpoint: z.string(),
  billing: RunnerBillingPostureSchema,
  asOf: z.string(),
});

export const OfferingBillingPresentationSchema = z.object({
  costLabel: z.string(),
  billingLabel: z.string(),
});
export type ProviderRunMetadata = z.infer<typeof ProviderRunMetadataSchema>;
export type OfferingBillingPresentation = z.infer<typeof OfferingBillingPresentationSchema>;

export const CostBreakdownSchema = z.object({
  hypotheticalCost: z.number().nonnegative(),
  actualPlannerCost: z.number().nonnegative(),
  actualImplementerCost: z.number().nonnegative(),
  actualReviewerCost: z.number().nonnegative().optional(),
  totalActualCost: z.number().nonnegative(),
  savingsAmount: z.number(),
  savingsPercentage: z.number(),
  localCompletionRate: z.number().nonnegative().max(1),
  hasPricedUsage: z.boolean().optional(),
  hasUnpricedUsage: z.boolean().optional(),
  hasSavingsEstimate: z.boolean().optional(),
  isActualPlannerCostKnown: z.boolean().optional(),
  isActualImplementerCostKnown: z.boolean().optional(),
  isActualReviewerCostKnown: z.boolean().optional(),
  isTotalActualCostKnown: z.boolean().optional(),
  isAllPlannerBaselineKnown: z.boolean().optional(),
  providerCosts: z.record(z.string(), ProviderCostSchema).optional(),
  /** Billing identity of every runner the run used, keyed by tool/provider id. */
  providerRunMetadata: z.record(z.string(), ProviderRunMetadataSchema).optional(),
  /** Offering-correct cost and billing labels for those runners. */
  offeringPresentations: z.record(z.string(), OfferingBillingPresentationSchema).optional(),
  cacheReadSavings: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
});

export const CostPredictionSchema = z.object({
  estimatedTasks: z.number().nonnegative(),
  lowCost: z.number().nonnegative(),
  expectedCost: z.number().nonnegative(),
  highCost: z.number().nonnegative(),
  plannerTool: z.string(),
  implementerTool: z.string(),
  deterministic: z
    .object({
      estimateScope: z.literal('prompt-input-only').optional(),
      taskCount: z.number().int().nonnegative(),
      taskFitCounts: z.object({
        fits: z.number().int().nonnegative(),
        tight: z.number().int().nonnegative(),
        overflow: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
      }),
      contextConfidenceCounts: z.object({
        contextExplicit: z.number().int().nonnegative(),
        contextDetected: z.number().int().nonnegative(),
        contextKnownCatalog: z.number().int().nonnegative(),
        contextCachedProvider: z.number().int().nonnegative(),
        contextConservativeFallback: z.number().int().nonnegative(),
        profileUnavailable: z.number().int().nonnegative(),
      }),
      priceConfidenceCounts: z.object({
        priceKnown: z.number().int().nonnegative(),
        priceUnknown: z.number().int().nonnegative(),
        profileUnavailable: z.number().int().nonnegative(),
      }),
      tasks: z.array(
        z.object({
          taskId: TaskIdSchema,
          title: z.string(),
          estimatedPromptTokens: z.number().int().nonnegative(),
          selectedProfileId: z.string().nullable(),
          contextFit: z.enum([...TASK_CONTEXT_FITS, 'unknown']),
          contextConfidence: EstimateContextConfidenceSchema,
          priceConfidence: EstimatePriceConfidenceSchema,
          estimatedImplementerCost: z.number().nonnegative().nullable(),
          hypotheticalPlannerCost: z.number().nonnegative().nullable(),
        }),
      ),
      totals: z.object({
        knownActualEstimate: z.number().nonnegative().nullable(),
        hypotheticalAllPlanner: z.number().nonnegative().nullable(),
        estimatedSavings: z.number().nullable(),
        unknownCostReason: z.array(EstimateUnknownCostReasonSchema),
      }),
    })
    .optional(),
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

export const ReviewVerdictSchema = z.enum(['pass', 'pass_with_notes', 'fail']);

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
  estimatedCostSavings: z.string(),
  escalationRate: z.number().nonnegative(),
  taskBreakdown: z.array(TaskTokenUsageSchema).optional(),
  costBreakdown: CostBreakdownSchema.optional(),
  plannerTool: z.string().optional(),
  plannerModel: z.string().optional(),
  implementerTool: z.string().optional(),
  implementerModel: z.string().optional(),
  reviewerTool: z.string().optional(),
  reviewerModel: z.string().optional(),
  phaseTimings: z.record(z.string(), z.number()).optional(),
  mode: WorkflowModeSchema.optional(),
  evidenceSummary: z
    .object({
      path: z.string(),
      totalTasks: z.number().nonnegative(),
      tasksWithValidationEvidence: z.number().nonnegative(),
      escalatedTasks: z.number().nonnegative(),
      failedTasks: z.number().nonnegative(),
      rejectionCount: z.number().nonnegative().optional(),
    })
    .optional(),
  briefQuality: BriefQualitySummarySchema.optional(),
  driftSummary: DriftSummarySchema.optional(),
  chainDriftSummary: ChainDriftSummarySchema.optional(),
  costPrediction: CostPredictionSchema.optional(),
  checkpointSummary: CheckpointSummaryRollupSchema.optional(),
  reviewPacket: ReviewPacketSummarySchema.optional(),
});

export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type CostPrediction = z.infer<typeof CostPredictionSchema>;
export type CheckpointSummaryRollup = z.infer<typeof CheckpointSummaryRollupSchema>;
export type ReviewPacketSummary = z.infer<typeof ReviewPacketSummarySchema>;

export interface CostKnownFlags {
  plannerCostKnown: boolean;
  implementerCostKnown: boolean;
  reviewerCostKnown?: boolean;
  totalCostKnown: boolean;
  allPlannerBaselineKnown: boolean;
}

export function costKnownFlags(breakdown: CostBreakdown): CostKnownFlags {
  const plannerCostKnown =
    breakdown.isActualPlannerCostKnown ??
    !(breakdown.hasUnpricedUsage === true && breakdown.hasPricedUsage !== true);
  const implementerCostKnown =
    breakdown.isActualImplementerCostKnown ?? !(breakdown.hasUnpricedUsage === true);
  const totalCostKnown =
    breakdown.isTotalActualCostKnown ?? (plannerCostKnown && implementerCostKnown);
  const allPlannerBaselineKnown =
    breakdown.isAllPlannerBaselineKnown ?? breakdown.hasSavingsEstimate ?? true;
  return {
    plannerCostKnown,
    implementerCostKnown,
    ...(breakdown.isActualReviewerCostKnown !== undefined && {
      reviewerCostKnown: breakdown.isActualReviewerCostKnown,
    }),
    totalCostKnown,
    allPlannerBaselineKnown,
  };
}

const UNMETERED_OFFERINGS = new Set<ApiOffering>(['coding-subscription', 'local']);

/**
 * The single cost label that describes a whole run, available only when every
 * runner it used bills outside per-token metering and they agree on one label.
 * A dollar figure would misreport those runs as a charge that never happened;
 * any metered runner makes the dollar figure the honest answer again.
 */
export function unmeteredRunCostLabel(breakdown: CostBreakdown): string | null {
  const entries = Object.entries(breakdown.providerRunMetadata ?? {});
  if (entries.length === 0) return null;
  const labels = new Set<string>();
  for (const [tool, metadata] of entries) {
    if (!UNMETERED_OFFERINGS.has(metadata.offering)) return null;
    const label = breakdown.offeringPresentations?.[tool]?.costLabel;
    if (label === undefined) return null;
    labels.add(label);
  }
  return labels.size === 1 ? ([...labels][0] ?? null) : null;
}
