import { z } from 'zod';
import { TaskSpecSchema } from './plan.js';
import type { Task } from './task.js';

const diagnosis = { diagnosis: z.string() };

const GuidanceActionSchema = z.object({
  ...diagnosis,
  action: z.literal('guidance'),
  instructions: z.string(),
  context: z.string().nullable(),
});

const RewriteTaskActionSchema = z.object({
  ...diagnosis,
  action: z.literal('rewrite-task'),
  task: TaskSpecSchema,
});

const SplitTaskActionSchema = z.object({
  ...diagnosis,
  action: z.literal('split-task'),
  tasks: z.array(TaskSpecSchema).min(2).max(4),
});

const VerifyActionSchema = z.object({
  ...diagnosis,
  action: z.literal('verify'),
  checkIds: z.array(z.string()),
  reason: z.string(),
});

const AskUserActionSchema = z.object({
  ...diagnosis,
  action: z.literal('ask-user'),
  question: z.string(),
  whyOnlyUserCanAnswer: z.string(),
  choices: z.array(z.string()).nullable(),
  default: z.string().nullable(),
});

const deviationDecision = z.object({ what: z.string(), why: z.string() });

const ConfirmActionSchema = z.object({
  ...diagnosis,
  action: z.literal('confirm'),
  decisions: z.array(deviationDecision),
});

export const ConsultAnswerSchema = z.object({
  answer: z.union([
    GuidanceActionSchema,
    RewriteTaskActionSchema,
    SplitTaskActionSchema,
    VerifyActionSchema,
    AskUserActionSchema,
    ConfirmActionSchema,
  ]),
});
export type ConsultAnswer = z.infer<typeof ConsultAnswerSchema>;

/**
 * The answer schema of one consult. A deviation consult takes `guidance` only once the user
 * answered its question (`answered`): the guidance carries out that answer.
 */
export function consultAnswerSchemaFor(
  task: Task,
  reason: ConsultReason = 'failed',
  answered = false,
) {
  const schema =
    reason === 'stale'
      ? StaleConsultAnswerSchema
      : reason !== 'deviation'
        ? ConsultAnswerSchema
        : answered
          ? AnsweredDeviationConsultAnswerSchema
          : DeviationConsultAnswerSchema;
  return schema.superRefine((value, ctx) => {
    if (value.answer.action === 'rewrite-task' && value.answer.task.id !== task.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['answer', 'task', 'id'],
        message: `a rewrite-task must keep the task id ${task.id}; the answer changes it to ${value.answer.task.id}`,
      });
    }
    if (value.answer.action === 'split-task' && task.parentId !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['answer', 'tasks'],
        message: `${task.id} is already a subtask of a split and cannot be split again`,
      });
    }
  });
}

export const StaleConsultAnswerSchema = z.object({
  answer: z.union([GuidanceActionSchema, RewriteTaskActionSchema]),
});

export const DeviationConsultAnswerSchema = z.object({
  answer: z.union([ConfirmActionSchema, AskUserActionSchema]),
});

export const AnsweredDeviationConsultAnswerSchema = z.object({
  answer: z.union([ConfirmActionSchema, AskUserActionSchema, GuidanceActionSchema]),
});

export const ImplementerReportSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('done'),
    filesChanged: z.array(z.string()),
    touchedNotSuggested: z.array(z.object({ file: z.string(), reason: z.string().default('') })),
    notes: z.string().nullable(),
    decisions: z.array(deviationDecision).default([]),
  }),
  z.object({
    status: z.literal('blocked'),
    question: z.string(),
    filesNeeded: z.array(z.string()),
  }),
]);
export type ImplementerReport = z.infer<typeof ImplementerReportSchema>;

export const CONSULT_REASONS = ['failed', 'blocked', 'stale', 'deviation'] as const;
export type ConsultReason = (typeof CONSULT_REASONS)[number];

/** The seat that answers a consult: the reviewer for a fix task's repair, the planner for the rest. */
export const CONSULT_SEATS = ['plan', 'review'] as const;
export type ConsultSeat = (typeof CONSULT_SEATS)[number];

const { $schema: _consultDraftRef, ...consultAnswerJsonSchema } =
  z.toJSONSchema(ConsultAnswerSchema);
export const CONSULT_ANSWER_JSON_SCHEMA = consultAnswerJsonSchema;

const { $schema: _staleDraftRef, ...staleConsultAnswerJsonSchema } =
  z.toJSONSchema(StaleConsultAnswerSchema);
export const STALE_CONSULT_ANSWER_JSON_SCHEMA = staleConsultAnswerJsonSchema;

const { $schema: _deviationDraftRef, ...deviationConsultAnswerJsonSchema } = z.toJSONSchema(
  DeviationConsultAnswerSchema,
);
export const DEVIATION_CONSULT_ANSWER_JSON_SCHEMA = deviationConsultAnswerJsonSchema;

const { $schema: _answeredDeviationDraftRef, ...answeredDeviationConsultAnswerJsonSchema } =
  z.toJSONSchema(AnsweredDeviationConsultAnswerSchema);
export const ANSWERED_DEVIATION_CONSULT_ANSWER_JSON_SCHEMA =
  answeredDeviationConsultAnswerJsonSchema;
