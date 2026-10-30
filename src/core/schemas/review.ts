import { z } from 'zod';
import { TaskSpecSchema } from './plan.js';
import { TaskIdSchema } from './task.js';

const ReviewTaskResultSchema = z.object({
  id: TaskIdSchema,
  plan: z.enum(['met', 'partial', 'missed']),
  note: z.string(),
});

const ReviewCriterionResultSchema = z.object({
  id: z.string(),
  status: z.enum(['pass', 'fail', 'unverified']),
  evidence: z.string(),
});

const ReviewFindingSchema = z.object({
  id: z.string(),
  kind: z.enum(['defect', 'plan-gap', 'unverified', 'question']),
  severity: z.enum(['blocking', 'minor']),
  taskId: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  text: z.string(),
  acceptance: z.string().nullable(),
  checkIds: z.array(z.string()).nullable(),
  criterionId: z.string().nullable(),
});

export const ReviewFindingCountsSchema = z.object({
  blocking: z.number().int().nonnegative(),
  minor: z.number().int().nonnegative(),
  outOfScope: z.number().int().nonnegative().optional(),
});
export type ReviewFindingCounts = z.infer<typeof ReviewFindingCountsSchema>;

export const ReviewVerdictSchema = z.object({
  tasks: z.array(ReviewTaskResultSchema),
  criteria: z.array(ReviewCriterionResultSchema),
  findings: z.array(ReviewFindingSchema),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const TriageFixTaskSchema = TaskSpecSchema.extend({
  findingIds: z.array(z.string()).min(1),
});

export const TriageResultSchema = z.object({
  fixTasks: z.array(TriageFixTaskSchema),
  rejected: z.array(
    z.object({
      findingId: z.string(),
      reason: z.string(),
    }),
  ),
  ask: z
    .object({
      question: z.string(),
      whyOnlyUserCanAnswer: z.string(),
    })
    .nullable(),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

/** A red input the reviewer rejected, with its reason: it no longer blocks the review. */
export const SetAsideSchema = z.object({ id: z.string(), reason: z.string() });
export type SetAside = z.infer<typeof SetAsideSchema>;

export const TriageInputSchema = z.object({
  id: z.string(),
  kind: z.enum(['defect', 'question', 'answer']),
  source: z.enum(['user', 'apply', 'check']),
  text: z.string(),
  file: z.string().nullable(),
  /** A red check: its id, the command it ran and its captured output. */
  checkIds: z.array(z.string()).optional(),
  command: z.string().optional(),
  output: z.string().optional(),
  /** The failure keys of its red that this input answers. */
  failureKeys: z.array(z.string()).optional(),
  /** Every failure key of the original red, before its run-base split. */
  redKeys: z.array(z.string()).optional(),
});
export type TriageInput = z.infer<typeof TriageInputSchema>;

/** The ids of the project gate's commands, V1, V2, … in the order the plan names them. */
export const REVIEW_CHECK_ID = /^V\d+$/;

const { $schema: _reviewDraftRef, ...reviewVerdictJsonSchema } =
  z.toJSONSchema(ReviewVerdictSchema);
export const REVIEW_VERDICT_JSON_SCHEMA = reviewVerdictJsonSchema;

export const ReviewAnswerSchema = ReviewVerdictSchema.extend(TriageResultSchema.shape);
export type ReviewAnswer = z.infer<typeof ReviewAnswerSchema>;

const { $schema: _answerDraftRef, ...reviewAnswerJsonSchema } = z.toJSONSchema(ReviewAnswerSchema);
export const REVIEW_ANSWER_JSON_SCHEMA = reviewAnswerJsonSchema;
