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
  verify: z.array(
    z.object({
      findingId: z.string(),
      checkIds: z.array(z.string()).min(1),
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

/** The ids the reviewer gives the commands it chooses before a review. */
export const REVIEW_CHECK_ID = /^V\d+$/;

/** The most reviewer checks one plan call may choose. */
export const MAX_REVIEW_CHECKS = 6;

/**
 * The commands the reviewer chooses to verify the change, the tests or checks it chose not to run,
 * and why it chose none when it chose none. SPLITBRIEF runs the commands; the reviewer never does.
 */
export const ReviewChecksPlanObjectSchema = z.object({
  commands: z
    .array(
      z.object({
        id: z.string(),
        command: z.string().min(1),
        reason: z.string().min(1),
      }),
    )
    .max(MAX_REVIEW_CHECKS),
  declined: z.array(z.object({ target: z.string().min(1), reason: z.string().min(1) })),
  reason: z.string().nullable(),
});

export const ReviewChecksPlanSchema = ReviewChecksPlanObjectSchema.superRefine((plan, ctx) => {
  if (plan.commands.length === 0 && (plan.reason ?? '').trim() === '') {
    ctx.addIssue({ code: 'custom', message: 'reason: say why no command verifies this change' });
  }
  const ids = plan.commands.map((command) => command.id);
  if (ids.some((id) => !REVIEW_CHECK_ID.test(id))) {
    ctx.addIssue({ code: 'custom', message: 'commands: every id is V1, V2, …' });
  }
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'commands: every id must be unique' });
  }
});
export type ReviewChecksPlan = z.infer<typeof ReviewChecksPlanSchema>;

const { $schema: _checksDraftRef, ...reviewChecksPlanJsonSchema } = z.toJSONSchema(
  ReviewChecksPlanObjectSchema,
);
export const REVIEW_CHECKS_PLAN_JSON_SCHEMA = reviewChecksPlanJsonSchema;

const { $schema: _reviewDraftRef, ...reviewVerdictJsonSchema } =
  z.toJSONSchema(ReviewVerdictSchema);
export const REVIEW_VERDICT_JSON_SCHEMA = reviewVerdictJsonSchema;

export const ReviewAnswerSchema = ReviewVerdictSchema.extend(TriageResultSchema.shape);
export type ReviewAnswer = z.infer<typeof ReviewAnswerSchema>;

const { $schema: _answerDraftRef, ...reviewAnswerJsonSchema } = z.toJSONSchema(ReviewAnswerSchema);
export const REVIEW_ANSWER_JSON_SCHEMA = reviewAnswerJsonSchema;
