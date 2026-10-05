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
});
export type TriageInput = z.infer<typeof TriageInputSchema>;

const { $schema: _reviewDraftRef, ...reviewVerdictJsonSchema } =
  z.toJSONSchema(ReviewVerdictSchema);
export const REVIEW_VERDICT_JSON_SCHEMA = reviewVerdictJsonSchema;

const { $schema: _triageDraftRef, ...triageResultJsonSchema } = z.toJSONSchema(TriageResultSchema);
export const TRIAGE_RESULT_JSON_SCHEMA = triageResultJsonSchema;
