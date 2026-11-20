import { z } from 'zod';
import { BriefExecutionSchema } from './brief-execution.js';
import { PhaseSchema, REVIEW_VERDICTS, RunnerKindSchema, WorkflowModeSchema } from './enums.js';
import { TaskIdSchema } from './task.js';
import { parseRunnerIdentityKey } from '../providers/catalog.js';
import { narrowRecord } from '../../utils/type-guards.js';

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

export const FinalReviewVerdictSchema = z.enum(REVIEW_VERDICTS);

export const FinalReviewFindingCountsSchema = z.object({
  critical: z.number().int().nonnegative(),
  warning: z.number().int().nonnegative(),
  note: z.number().int().nonnegative(),
});

export const FinalReviewFindingSeveritySchema = FinalReviewFindingCountsSchema.keyof();

export const ReviewPacketSummarySchema = z.object({
  jsonPath: z.string(),
  markdownPath: z.string(),
  generatedAt: z.string(),
  finalReviewStatus: ReviewFinalReviewStatusSchema,
  finalReviewVerdict: FinalReviewVerdictSchema.nullable().default(null),
  finalReviewFindingCounts: FinalReviewFindingCountsSchema.default({
    critical: 0,
    warning: 0,
    note: 0,
  }),
  driftPassed: z.boolean().nullable(),
  evidenceValidatedTasks: z.number().int().nonnegative(),
  evidenceTotalTasks: z.number().int().nonnegative(),
  missingArtifactCount: z.number().int().nonnegative(),
});

const SummaryRecordSchema = z.object({
  feature: z.string(),
  totalTasks: z.number().nonnegative(),
  completedByLocal: z.number().nonnegative(),
  escalatedToPlanner: z.number().nonnegative(),
  skipped: z.number().nonnegative(),
  failed: z.number().nonnegative(),
  totalTime: z.number().nonnegative(),
  /** How long the run ran, in ms: its running stretches, read from its log. Absent on older records. */
  activeTime: z.number().nonnegative().optional(),
  escalationRate: z.number().nonnegative(),
  taskBreakdown: z.array(BriefExecutionSchema).optional(),
  plannerTool: z.string().optional(),
  plannerModel: z.string().optional(),
  plannerKind: RunnerKindSchema.optional(),
  /** The axis words the seat ran at (effort, thinking, fast). Absent on older records. */
  plannerAxes: z.array(z.string()).readonly().optional(),
  implementerTool: z.string().optional(),
  implementerModel: z.string().optional(),
  implementerKind: RunnerKindSchema.optional(),
  implementerAxes: z.array(z.string()).readonly().optional(),
  reviewerTool: z.string().optional(),
  reviewerModel: z.string().optional(),
  reviewerKind: RunnerKindSchema.optional(),
  reviewerAxes: z.array(z.string()).readonly().optional(),
  /** REVIEW was None for this run, so no seat reviewed it. */
  reviewerSeat: z.literal('none').optional(),
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
      verdict: FinalReviewVerdictSchema.nullable(),
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

export const SummarySchema = z.preprocess((value) => {
  const summary = narrowRecord(value);
  const cost = narrowRecord(summary?.costBreakdown);
  const metadata = narrowRecord(cost?.providerRunMetadata);
  if (summary === null || metadata === null) return value;

  const kindsByTool = new Map<string, Set<string>>();
  for (const key of Object.keys(metadata)) {
    const { id, kind } = parseRunnerIdentityKey(key);
    if (kind === undefined) continue;
    const kinds = kindsByTool.get(id) ?? new Set<string>();
    kinds.add(kind);
    kindsByTool.set(id, kinds);
  }
  const kindOf = (tool: unknown) => {
    const kinds = typeof tool === 'string' ? kindsByTool.get(tool) : undefined;
    return kinds?.size === 1 ? [...kinds][0] : undefined;
  };
  return {
    ...summary,
    plannerKind: summary.plannerKind ?? kindOf(summary.plannerTool),
    implementerKind: summary.implementerKind ?? kindOf(summary.implementerTool),
    reviewerKind: summary.reviewerKind ?? kindOf(summary.reviewerTool),
    taskBreakdown: Array.isArray(summary.taskBreakdown)
      ? summary.taskBreakdown.map((value: unknown) => {
          const task = narrowRecord(value);
          return task === null ? value : { ...task, kind: task.kind ?? kindOf(task.tool) };
        })
      : summary.taskBreakdown,
  };
}, SummaryRecordSchema);

export type BriefQualitySummary = z.infer<typeof BriefQualitySummarySchema>;
export type FinalReviewVerdict = z.infer<typeof FinalReviewVerdictSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type ReviewPacketSummary = z.infer<typeof ReviewPacketSummarySchema>;
