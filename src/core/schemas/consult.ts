import { z } from 'zod';
import { isRecord } from '../../utils/type-guards.js';
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

/** The step a `cannot` takes when the user chose Decide for me and is not asked. */
export const CANNOT_NEXT_STEPS = ['skip-brief', 'end-run'] as const;
export type CannotNextStep = (typeof CANNOT_NEXT_STEPS)[number];

const CannotActionSchema = z.object({
  ...diagnosis,
  action: z.literal('cannot'),
  reason: z.string(),
  next: z.enum(CANNOT_NEXT_STEPS).nullable(),
});

const AcceptActionSchema = z.object({
  ...diagnosis,
  action: z.literal('accept'),
  note: z.string(),
});

export const ConsultAnswerSchema = z.object({
  answer: z.union([
    GuidanceActionSchema,
    RewriteTaskActionSchema,
    SplitTaskActionSchema,
    VerifyActionSchema,
    AskUserActionSchema,
    CannotActionSchema,
    AcceptActionSchema,
  ]),
});
export type ConsultAnswer = z.infer<typeof ConsultAnswerSchema>;

/**
 * The answer schema of one consult on the task. Only a stuck review takes `accept`, and its split
 * replaces the reviewer's next fix briefs, so a subtask may take one there.
 */
export function consultAnswerSchemaFor(task: Task, reason: ConsultReason) {
  return ConsultAnswerSchema.superRefine((value, ctx) => {
    if (value.answer.action === 'accept' && reason !== 'no-progress') {
      ctx.addIssue({
        code: 'custom',
        path: ['answer', 'action'],
        message: 'only a stuck review takes accept',
      });
    }
    if (value.answer.action === 'rewrite-task' && value.answer.task.id !== task.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['answer', 'task', 'id'],
        message: `a rewrite-task must keep the task id ${task.id}; the answer changes it to ${value.answer.task.id}`,
      });
    }
    if (
      value.answer.action === 'split-task' &&
      task.parentId !== undefined &&
      reason !== 'no-progress'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['answer', 'tasks'],
        message: `${task.id} is already a subtask of a split and cannot be split again`,
      });
    }
  });
}

/** A decision the implementer reports; a decision written as text has no reason. */
const ReportedDecisionSchema = z.preprocess(
  (decision) => (typeof decision === 'string' ? { what: decision, why: null } : decision),
  z.object({ what: z.string(), why: z.string().nullable() }),
);
export type ReportedDecision = z.infer<typeof ReportedDecisionSchema>;

const DoneReportSchema = z.object({
  status: z.literal('done'),
  filesChanged: z.array(z.string()),
  touchedNotSuggested: z.array(z.object({ file: z.string(), reason: z.string().default('') })),
  notes: z.string().nullable(),
  decisions: z.array(ReportedDecisionSchema).default([]),
});

const BlockedReportSchema = z.object({
  status: z.literal('blocked'),
  question: z.string(),
  filesNeeded: z.array(z.string()),
});

export const ImplementerReportSchema = z.discriminatedUnion('status', [
  DoneReportSchema,
  BlockedReportSchema,
]);
export type ImplementerReport = z.infer<typeof ImplementerReportSchema>;

/**
 * The implementer's report as SPLITBRIEF reads it. A done or blocked report keeps every field
 * that matches its contract; a field that does not, or is missing, reads as empty and is named
 * in `dropped`. A report without a known status is not read.
 */
export function readImplementerReport(
  value: unknown,
): { report: ImplementerReport; dropped: string[] } | undefined {
  const parsed = ImplementerReportSchema.safeParse(value);
  if (parsed.success) return { report: parsed.data, dropped: [] };
  if (!isRecord(value)) return undefined;
  const dropped: string[] = [];
  const field = <T>(name: string, schema: z.ZodType<T>, empty: T): T => {
    const read = schema.safeParse(value[name]);
    if (read.success) return read.data;
    dropped.push(name);
    return empty;
  };
  if (value.status === 'blocked') {
    const { shape } = BlockedReportSchema;
    return {
      report: {
        status: 'blocked',
        question: field('question', shape.question, ''),
        filesNeeded: field('filesNeeded', shape.filesNeeded, []),
      },
      dropped,
    };
  }
  if (value.status !== 'done') return undefined;
  const { shape } = DoneReportSchema;
  return {
    report: {
      status: 'done',
      filesChanged: field('filesChanged', shape.filesChanged, []),
      touchedNotSuggested: field('touchedNotSuggested', shape.touchedNotSuggested, []),
      notes: field('notes', shape.notes, null),
      decisions: field('decisions', shape.decisions, []),
    },
    dropped,
  };
}

export const CONSULT_REASONS = ['failed', 'blocked', 'no-progress'] as const;
export type ConsultReason = (typeof CONSULT_REASONS)[number];

/** The seat a consult record names: the planner, or the reviewer that answered an older run's fix task. */
export const CONSULT_SEATS = ['plan', 'review'] as const;
export type ConsultSeat = (typeof CONSULT_SEATS)[number];

const { $schema: _consultDraftRef, ...consultAnswerJsonSchema } =
  z.toJSONSchema(ConsultAnswerSchema);
export const CONSULT_ANSWER_JSON_SCHEMA = consultAnswerJsonSchema;
