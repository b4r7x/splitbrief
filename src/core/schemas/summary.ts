import { z } from 'zod';
import { TaskTokenUsageSchema, TokenUsageSchema } from './tokens.js';
import { WorkflowModeSchema } from './enums.js';

export const ChainDriftSummarySchema = z.object({
  score: z.number().min(0).max(1),
  chainLength: z.number().int().nonnegative(),
  uniqueOutOfBoundsFiles: z.array(z.string()),
  representativePath: z.string(),
  emittedChainCount: z.number().int().nonnegative(),
});

export type ChainDriftSummary = z.infer<typeof ChainDriftSummarySchema>;

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
});

export const CostBreakdownSchema = z.object({
  hypotheticalCost: z.number().nonnegative(),
  actualPlannerCost: z.number().nonnegative(),
  actualImplementerCost: z.number().nonnegative(),
  totalActualCost: z.number().nonnegative(),
  savingsAmount: z.number(),
  savingsPercentage: z.number(),
  localCompletionRate: z.number().nonnegative().max(1),
  hasPricedUsage: z.boolean().optional(),
  hasUnpricedUsage: z.boolean().optional(),
  hasSavingsEstimate: z.boolean().optional(),
  isActualPlannerCostKnown: z.boolean().optional(),
  isActualImplementerCostKnown: z.boolean().optional(),
  isTotalActualCostKnown: z.boolean().optional(),
  isAllPlannerBaselineKnown: z.boolean().optional(),
  providerCosts: z.record(z.string(), ProviderCostSchema).optional(),
  cacheReadSavings: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
});

export const PlannerEstimateReviewClassificationSchema = z.enum(['ok', 'split-suggested', 'risk', 'needs-user-decision']);

export const PlannerEstimateReviewSchema = z.object({
  extraPlannerCall: z.boolean(),
  status: z.enum(['running', 'completed', 'unavailable']),
  classification: PlannerEstimateReviewClassificationSchema.nullable(),
  affectedTaskIds: z.array(z.string()),
  reason: z.string().nullable(),
  recommendedUserDecision: z.string().nullable(),
  error: z.string().optional(),
});

export const CostPredictionSchema = z.object({
  estimatedTasks: z.number().nonnegative(),
  lowCost: z.number().nonnegative(),
  expectedCost: z.number().nonnegative(),
  highCost: z.number().nonnegative(),
  plannerTool: z.string(),
  implementerTool: z.string(),
  deterministic: z.object({
    taskCount: z.number().int().nonnegative(),
    taskFitCounts: z.object({
      fits: z.number().int().nonnegative(),
      tight: z.number().int().nonnegative(),
      overflow: z.number().int().nonnegative(),
      unknown: z.number().int().nonnegative(),
    }),
    contextConfidenceCounts: z.object({
      contextExplicit: z.number().int().nonnegative(),
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
    tasks: z.array(z.object({
      taskId: z.string(),
      title: z.string(),
      estimatedPromptTokens: z.number().int().nonnegative(),
      selectedProfileId: z.string().nullable(),
      contextFit: z.enum(['fits', 'tight', 'overflow', 'unknown']),
      contextConfidence: z.enum([
        'context-explicit',
        'context-known-catalog',
        'context-cached-provider',
        'context-conservative-fallback',
        'profile-unavailable',
      ]),
      priceConfidence: z.enum(['price-known', 'price-unknown', 'profile-unavailable']),
      estimatedImplementerCost: z.number().nonnegative().nullable(),
      hypotheticalPlannerCost: z.number().nonnegative().nullable(),
    })),
    totals: z.object({
      knownActualEstimate: z.number().nonnegative().nullable(),
      hypotheticalAllPlanner: z.number().nonnegative().nullable(),
      estimatedSavings: z.number().nullable(),
      unknownCostReason: z.array(z.enum([
        'implementer-price-unknown',
        'planner-price-unknown',
        'profile-unavailable',
      ])),
    }),
  }).optional(),
  plannerEstimateReview: PlannerEstimateReviewSchema.optional(),
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
  diffCommand: z.string().nullable(),
  restoreCommand: z.string().nullable(),
});

export const ReviewPacketSummarySchema = z.object({
  jsonPath: z.string(),
  markdownPath: z.string(),
  generatedAt: z.string(),
  finalReviewStatus: z.enum(['written', 'failed', 'missing', 'skipped']),
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
  phaseTimings: z.record(z.string(), z.number()).optional(),
  mode: WorkflowModeSchema.optional(),
  evidenceSummary: z.object({
    path: z.string(),
    totalTasks: z.number().nonnegative(),
    tasksWithValidationEvidence: z.number().nonnegative(),
    escalatedTasks: z.number().nonnegative(),
    failedTasks: z.number().nonnegative(),
    rejectionCount: z.number().nonnegative().optional(),
  }).optional(),
  briefQuality: BriefQualitySummarySchema.optional(),
  driftSummary: DriftSummarySchema.optional(),
  chainDriftSummary: ChainDriftSummarySchema.optional(),
  costPrediction: CostPredictionSchema.optional(),
  checkpointSummary: CheckpointSummaryRollupSchema.optional(),
  reviewPacket: ReviewPacketSummarySchema.optional(),
});

export type BriefQualitySummary = z.infer<typeof BriefQualitySummarySchema>;
export type DriftSummary = z.infer<typeof DriftSummarySchema>;
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type CostPrediction = z.infer<typeof CostPredictionSchema>;
export type PlannerEstimateReviewClassification = z.infer<typeof PlannerEstimateReviewClassificationSchema>;
export type PlannerEstimateReview = z.infer<typeof PlannerEstimateReviewSchema>;
export type CheckpointSummaryRollup = z.infer<typeof CheckpointSummaryRollupSchema>;
export type ReviewPacketSummary = z.infer<typeof ReviewPacketSummarySchema>;

export interface CostKnownFlags {
  plannerCostKnown: boolean;
  implementerCostKnown: boolean;
  totalCostKnown: boolean;
  allPlannerBaselineKnown: boolean;
}

export function costKnownFlags(breakdown: CostBreakdown): CostKnownFlags {
  const plannerCostKnown = breakdown.isActualPlannerCostKnown
    ?? !(breakdown.hasUnpricedUsage === true && breakdown.hasPricedUsage !== true);
  const implementerCostKnown = breakdown.isActualImplementerCostKnown
    ?? !(breakdown.hasUnpricedUsage === true);
  const totalCostKnown = breakdown.isTotalActualCostKnown
    ?? (plannerCostKnown && implementerCostKnown);
  const allPlannerBaselineKnown = breakdown.isAllPlannerBaselineKnown
    ?? (breakdown.hasSavingsEstimate ?? true);
  return { plannerCostKnown, implementerCostKnown, totalCostKnown, allPlannerBaselineKnown };
}
