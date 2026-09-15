import { z } from 'zod';
import { TaskTokenUsageSchema, TokenUsageSchema } from './tokens.js';
import { PhaseSchema, REVIEW_VERDICTS, WorkflowModeSchema } from './enums.js';
import { TaskIdSchema } from './task.js';
import { API_OFFERINGS, type ApiOffering } from '../providers/api-provider-catalog.js';
import { RunnerBillingPostureSchema } from '../runners/runner-billing.js';
import { uniqueInOrder } from '../../utils/collections.js';

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
  const labels: string[] = [];
  for (const [tool, metadata] of entries) {
    if (!UNMETERED_OFFERINGS.has(metadata.offering)) return null;
    const label = breakdown.offeringPresentations?.[tool]?.costLabel;
    if (label === undefined) return null;
    labels.push(label);
  }
  const unique = uniqueInOrder(labels);
  return unique.length === 0 ? null : unique.join(' · ');
}
