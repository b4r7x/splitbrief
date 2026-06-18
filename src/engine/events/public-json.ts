import { z } from 'zod';
import { TaskIdSchema } from '../../core/schemas/task.js';
import { RecoveryActionSchema, RecoveryReasonSchema } from '../../core/schemas/enums.js';
import { protectConsumerPayload, type CallConsumerContext } from '../calls/consumer-policy.js';
import { EngineEventSchema } from './schema.js';

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

export function protectHeadlessJsonRecord(
  record: HeadlessJsonRecord,
  context: CallConsumerContext = 'stdout-json',
): HeadlessJsonRecord {
  const protectedPayload = protectConsumerPayload({ context, payload: record });
  if (protectedPayload.oversized) {
    return {
      type: 'warning',
      message: `${context}: omitted oversized ${record.type} record exceeding ${protectedPayload.maxBytes} bytes`,
    };
  }

  const parsed = HeadlessJsonRecordSchema.safeParse(protectedPayload.payload);
  if (parsed.success) return parsed.data;

  return {
    type: 'warning',
    message: `${context}: omitted invalid ${record.type} record after public payload normalization`,
  };
}

export function writeHeadlessJsonRecord(
  record: HeadlessJsonRecord,
  out: NodeJS.WritableStream = process.stdout,
): void {
  out.write(JSON.stringify(protectHeadlessJsonRecord(record)) + '\n');
}
