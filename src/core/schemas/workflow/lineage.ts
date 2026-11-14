import { z } from 'zod';
import { isRecord } from '../../../utils/type-guards.js';
import { AttachmentSchema } from '../attachment.js';
import { TaskIdSchema, TaskSchema } from '../task.js';
import { ChangedFilesSnapshotSchema } from './changed-files.js';
import { nonnegativeInteger, ConsultRecordSchema } from './consult-record.js';

/**
 * A run saved before decisions went to the ledger kept deviation consults, and a run saved before
 * a brief with moved input files dispatched without a planner call kept stale consults; both load
 * as nothing.
 */
function dropRetiredConsults(value: unknown): unknown {
  return Array.isArray(value)
    ? value.filter(
        (record) =>
          !isRecord(record) ||
          (record.reason !== 'deviation' &&
            record.reason !== 'stale' &&
            record.action !== 'confirm'),
      )
    : value;
}

/** One failed attempt of a lineage: the brief and revision it ran, and its first error line. */
export const AttemptFailureSchema = z.object({
  attempt: z.number().int().positive(),
  taskId: TaskIdSchema,
  revision: z.number().int(),
  line: z.string(),
});
export type AttemptFailure = z.infer<typeof AttemptFailureSchema>;

export const LineageRecordSchema = z.object({
  attempts: nonnegativeInteger,
  /** The revision that already dispatched an attempt; a Try again of it runs on its own files. */
  dispatchedRevision: z.record(z.string(), z.number().int()).default({}),
  consultRecords: z.preprocess(dropRetiredConsults, z.array(ConsultRecordSchema)).default([]),
  replacedParents: z.array(TaskSchema).default([]),
  corrections: z.array(z.string()).optional(),
  correctionImages: z.array(AttachmentSchema).optional(),
  /** The task start of the lineage's first dispatch; kept only while one of its briefs is open. */
  startSnapshot: ChangedFilesSnapshotSchema.optional(),
  /**
   * The task start of each brief a rewrite or a split replaced, oldest first, with the writes of
   * its attempts and the briefs done when it started; kept only while one of its briefs is open.
   */
  replacedStarts: z
    .array(z.object({ snapshot: ChangedFilesSnapshotSchema, doneAtStart: z.array(TaskIdSchema) }))
    .optional(),
  attemptFailures: z.array(AttemptFailureSchema).optional(),
});
export type LineageRecord = z.infer<typeof LineageRecordSchema>;
