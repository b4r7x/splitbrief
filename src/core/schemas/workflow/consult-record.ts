import { z } from 'zod';
import { isRecord } from '../../../utils/type-guards.js';
import { CONSULT_REASONS, ConsultAnswerSchema, CONSULT_SEATS } from '../consult.js';
import { TaskIdSchema } from '../task.js';

export const nonnegativeInteger = z.number().int().nonnegative();

export const CONSULT_ACTION_KINDS = [
  'guidance',
  'rewrite-task',
  'split-task',
  'verify',
  'ask-user',
  'cannot',
  'accept',
] as const;

/** A \`cannot\` saved before it named its next step reads as naming none. */
function withCannotNext(value: unknown): unknown {
  return isRecord(value) &&
    isRecord(value.answer) &&
    value.answer.action === 'cannot' &&
    !('next' in value.answer)
    ? { ...value, answer: { ...value.answer, next: null } }
    : value;
}

export const ConsultRecordSchema = z.object({
  reason: z.enum(CONSULT_REASONS),
  action: z.enum(CONSULT_ACTION_KINDS),
  diagnosis: z.string(),
  at: z.string(),
  taskId: TaskIdSchema,
  revision: z.number().int(),
  answer: z.preprocess(withCannotNext, ConsultAnswerSchema),
  /** `review` on an older run's fix-task consult the reviewer answered; the planner answers the rest. */
  seat: z.enum(CONSULT_SEATS).optional(),
  /** The lineage's attempts before this answer; an older record does not carry it. */
  afterAttempt: nonnegativeInteger.optional(),
});
export type ConsultRecord = z.infer<typeof ConsultRecordSchema>;
