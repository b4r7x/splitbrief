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

export const CostPredictionSchema = z.object({
  estimatedTasks: z.number().nonnegative(),
  lowCost: z.number().nonnegative(),
  expectedCost: z.number().nonnegative(),
  highCost: z.number().nonnegative(),
  plannerTool: z.string(),
  implementerTool: z.string(),
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
  /**
   * Workflow mode the run actually executed in. Optional for backward
   * compatibility with persisted summaries from older sessions.
   */
  mode: WorkflowModeSchema.optional(),
  /**
   * Compact rollup of the evidence ledger written for the run, if any. Optional
   * for backward compatibility with sessions that ran before the ledger was
   * introduced. Full per-task evidence lives in `evidence.json` referenced by
   * `path`.
   */
  evidenceSummary: z.object({
    path: z.string(),
    totalTasks: z.number().nonnegative(),
    tasksWithValidationEvidence: z.number().nonnegative(),
    escalatedTasks: z.number().nonnegative(),
    failedTasks: z.number().nonnegative(),
    rejectionCount: z.number().nonnegative().optional(),
  }).optional(),
  /**
   * Brief quality gate result from the planner's task compilation step.
   * Optional for backward compatibility with older sessions.
   */
  briefQuality: BriefQualitySummarySchema.optional(),
  /**
   * Drift analysis result computed at the end of the run.
   * Optional for backward compatibility with older sessions.
   */
  driftSummary: DriftSummarySchema.optional(),
  /**
   * Chain drift analysis result from the run, if any chains were emitted.
   * Optional for backward compatibility with older sessions.
   */
  chainDriftSummary: ChainDriftSummarySchema.optional(),
  /**
   * Cost prediction made before implementing tasks. Optional — not present
   * in instant/quick modes that skip prediction or in old sessions.
   */
  costPrediction: CostPredictionSchema.optional(),
  /**
   * Compact checkpoint rollup derived from the review packet for the summary
   * screen. Optional for sessions created before review packets existed.
   */
  checkpointSummary: CheckpointSummaryRollupSchema.optional(),
  /**
   * Compact review-packet rollup for summary rendering. The canonical packet
   * remains `review-packet.json`.
   */
  reviewPacket: ReviewPacketSummarySchema.optional(),
});

export type BriefQualitySummary = z.infer<typeof BriefQualitySummarySchema>;
export type DriftSummary = z.infer<typeof DriftSummarySchema>;
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type CostPrediction = z.infer<typeof CostPredictionSchema>;
export type CheckpointSummaryRollup = z.infer<typeof CheckpointSummaryRollupSchema>;
export type ReviewPacketSummary = z.infer<typeof ReviewPacketSummarySchema>;
