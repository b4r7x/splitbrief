import { z } from 'zod';
import { TaskIdSchema } from '../../core/schemas/task.js';
import {
  RecoveryActionSchema,
  RecoveryReasonSchema,
  RecoveryStatusSchema,
} from '../../core/schemas/enums.js';
import { boundConsumerPayload, type CallConsumerContext } from '../../core/payload-bounds.js';
import { EngineEventSchema } from './schema.js';
import { boundEngineEventForConsumer } from './bound.js';

export const HeadlessJsonRecordSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('event'),
    data: EngineEventSchema,
  }),
  z.strictObject({
    type: z.literal('readiness_report'),
    report: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('recovery_required'),
    sessionId: z.string(),
    reason: RecoveryReasonSchema,
    status: RecoveryStatusSchema.optional(),
    message: z.string(),
    taskId: TaskIdSchema.optional(),
    files: z.array(z.string()).optional(),
    affectedTaskIds: z.array(TaskIdSchema).optional(),
    availableActions: z.array(RecoveryActionSchema),
    recommendedAction: RecoveryActionSchema,
  }),
  z.strictObject({
    type: z.literal('final_review_failed'),
    sessionId: z.string(),
  }),
  z.strictObject({
    type: z.literal('warning'),
    message: z.string(),
  }),
  z.strictObject({
    type: z.literal('error'),
    message: z.string(),
  }),
]);

export type HeadlessJsonRecord = z.infer<typeof HeadlessJsonRecordSchema>;

interface BoundHeadlessJsonRecordOptions {
  context?: CallConsumerContext | undefined;
}

export function boundHeadlessJsonRecord(
  record: HeadlessJsonRecord,
  opts: BoundHeadlessJsonRecordOptions = {},
): HeadlessJsonRecord {
  const context = opts.context ?? 'stdout-json';
  const boundedRecord =
    record.type === 'event'
      ? { type: 'event' as const, data: boundEngineEventForConsumer(record.data, context) }
      : record;

  const boundedPayload = boundConsumerPayload({ context, payload: boundedRecord });
  if (boundedPayload.oversized) {
    return {
      type: 'warning',
      message: `${context}: omitted oversized ${record.type} record exceeding ${boundedPayload.maxBytes} bytes`,
    };
  }

  const parsed = HeadlessJsonRecordSchema.safeParse(boundedPayload.payload);
  if (parsed.success) return parsed.data;

  return {
    type: 'warning',
    message: `${context}: omitted invalid ${record.type} record after public payload normalization`,
  };
}

export function writeHeadlessJsonRecord(
  record: HeadlessJsonRecord,
  out: NodeJS.WritableStream = process.stdout,
  opts: BoundHeadlessJsonRecordOptions = {},
): void {
  out.write(JSON.stringify(boundHeadlessJsonRecord(record, opts)) + '\n');
}
