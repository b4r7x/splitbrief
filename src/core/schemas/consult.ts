import { z } from 'zod';
import { TaskSpecSchema } from './plan.js';

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

export const ConsultAnswerSchema = z.object({
  answer: z.discriminatedUnion('action', [
    GuidanceActionSchema,
    RewriteTaskActionSchema,
    SplitTaskActionSchema,
    VerifyActionSchema,
    AskUserActionSchema,
  ]),
});
export type ConsultAnswer = z.infer<typeof ConsultAnswerSchema>;

export const StaleConsultAnswerSchema = z.object({
  answer: z.discriminatedUnion('action', [GuidanceActionSchema, RewriteTaskActionSchema]),
});

export const ImplementerReportSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('done'),
    filesChanged: z.array(z.string()),
    touchedNotSuggested: z.array(z.object({ file: z.string(), reason: z.string() })),
    notes: z.string().nullable(),
  }),
  z.object({
    status: z.literal('blocked'),
    question: z.string(),
    filesNeeded: z.array(z.string()),
  }),
]);
export type ImplementerReport = z.infer<typeof ImplementerReportSchema>;

export const CONSULT_REASONS = ['failed', 'blocked', 'stale'] as const;
export type ConsultReason = (typeof CONSULT_REASONS)[number];

const { $schema: _consultDraftRef, ...consultAnswerJsonSchema } =
  z.toJSONSchema(ConsultAnswerSchema);
export const CONSULT_ANSWER_JSON_SCHEMA = consultAnswerJsonSchema;

const { $schema: _staleDraftRef, ...staleConsultAnswerJsonSchema } =
  z.toJSONSchema(StaleConsultAnswerSchema);
export const STALE_CONSULT_ANSWER_JSON_SCHEMA = staleConsultAnswerJsonSchema;
