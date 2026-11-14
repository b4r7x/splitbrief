import { z } from 'zod';
import { ReviewVerdictSchema, TriageInputSchema, TriageResultSchema } from '../review/verdict.js';
import { TaskIdSchema } from '../task.js';
import { nonnegativeInteger } from './consult-record.js';

export const FixCyclesSchema = z.object({
  used: nonnegativeInteger,
  /** The fix cycles that ran a fix brief: the count the user reads. A state from before this field reads used. */
  briefed: nonnegativeInteger.optional(),
  notes: z.array(z.string()),
  /** The fix cycle that started and that no review has judged yet, with the id of its last inserted fix task. */
  open: z.object({ cycle: nonnegativeInteger, lastFixTaskId: TaskIdSchema.optional() }).optional(),
});
export type FixCycles = z.infer<typeof FixCyclesSchema>;

export const ReviewRecordSchema = z.object({
  scope: z.enum(['task', 'final']).optional(),
  afterTaskId: TaskIdSchema.optional(),
  cycle: z.number().int(),
  /** The fix cycle this review judges: it compares its blockers with that cycle's triage record. */
  judges: z.number().int().optional(),
  verdict: ReviewVerdictSchema,
  outcome: z.enum(['pass', 'pass-with-notes', 'fail']),
  verification: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['pass', 'fail', 'unverified']),
      output: z.string(),
    }),
  ),
  /** The red check and Apply inputs the answer left blocking; each one fails the review. */
  redInputs: z.array(TriageInputSchema.pick({ id: true, text: true })).optional(),
  /**
   * The reviewer checks of this review that were red at the run base too: each check, its command
   * and the failures that also fail before the run's changes. They raise no finding.
   */
  preExistingChecks: z
    .array(z.object({ id: z.string(), command: z.string(), keys: z.array(z.string()) }))
    .optional(),
  /** The render criteria that stayed unverified because the review seat takes no images. */
  unseenRenderCriteria: z.array(z.string()).optional(),
  at: z.string(),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

export const TriageRecordSchema = z.object({
  reviewAt: z.string().optional(),
  cycle: z.number().int(),
  at: z.string(),
  inputIds: z.array(z.string()),
  result: TriageResultSchema,
  /** The keys of the problems that failed the review this answer followed (`blockingKeys`). */
  blocking: z.array(z.string()).optional(),
  /** The kind of that review: it picks the review that judges this cycle (`ReviewRecord.judges`). */
  scope: z.enum(['task', 'final']).optional(),
});
export type TriageRecord = z.infer<typeof TriageRecordSchema>;

/** A check that was red at an Accept as is: its id, its command and the last line of its output. */
export const RedCheckSchema = z.object({
  id: z.string(),
  command: z.string().optional(),
  lastLine: z.string().optional(),
});
export type RedCheck = z.infer<typeof RedCheckSchema>;

export const PendingTriageSchema = z.object({
  inputs: z.array(TriageInputSchema),
  question: TriageResultSchema.shape.ask.optional(),
  reviewAfterTaskId: TaskIdSchema.optional(),
  /** The review judged its fix cycle stuck and asks the planner; a continue asks it again. */
  plannerConsult: z.literal(true).optional(),
});
