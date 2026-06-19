import { z } from 'zod';
import { TaskIdSchema } from '../../core/schemas/task.js';
import { RecoveryActionSchema, RecoveryReasonSchema } from '../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../core/schemas/recovery.js';
import { protectConsumerPayload, type CallConsumerContext } from '../calls/consumer-policy.js';
import { EngineEventSchema } from './schema.js';
import { protectEngineEventForConsumer, TRANSCRIPT_OMITTED_MESSAGE } from './protection.js';

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

interface ProtectHeadlessJsonRecordOptions {
  context?: CallConsumerContext | undefined;
  persistTranscript?: boolean | undefined;
}

export function projectRecoveryIssueForTranscriptPolicy(
  issue: RecoveryIssue,
  persistTranscript: boolean,
): RecoveryIssue {
  if (persistTranscript) return issue;
  return {
    id: issue.id,
    reason: issue.reason,
    phase: issue.phase,
    status: issue.status,
    ...(issue.taskId !== undefined && { taskId: issue.taskId }),
    ...(issue.taskTitle !== undefined && { taskTitle: TRANSCRIPT_OMITTED_MESSAGE }),
    files: issue.files,
    affectedTaskIds: issue.affectedTaskIds,
    message: TRANSCRIPT_OMITTED_MESSAGE,
    details: issue.details.map(omittedText),
    ...(issue.attempts !== undefined && { attempts: issue.attempts }),
    ...(issue.maxAttempts !== undefined && { maxAttempts: issue.maxAttempts }),
    ...(issue.selectedImplementerProfile !== undefined && {
      selectedImplementerProfile: issue.selectedImplementerProfile,
    }),
    availableActions: issue.availableActions,
    recommendedAction: issue.recommendedAction,
    ...(issue.selectedAction !== undefined && { selectedAction: issue.selectedAction }),
    createdAt: issue.createdAt,
  };
}

export function protectHeadlessJsonRecord(
  record: HeadlessJsonRecord,
  opts: CallConsumerContext | ProtectHeadlessJsonRecordOptions = {},
): HeadlessJsonRecord | null {
  const { context, persistTranscript } = resolveProtectHeadlessOptions(opts);
  const transcriptSafeRecord = projectHeadlessJsonRecordForTranscriptPolicy(
    record,
    context,
    persistTranscript,
  );
  if (transcriptSafeRecord === null) return null;

  const protectedPayload = protectConsumerPayload({ context, payload: transcriptSafeRecord });
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
  opts: ProtectHeadlessJsonRecordOptions = {},
): void {
  const protectedRecord = protectHeadlessJsonRecord(record, opts);
  if (protectedRecord === null) return;
  out.write(JSON.stringify(protectedRecord) + '\n');
}

function resolveProtectHeadlessOptions(
  opts: CallConsumerContext | ProtectHeadlessJsonRecordOptions,
): { context: CallConsumerContext; persistTranscript: boolean } {
  if (typeof opts === 'string') {
    return { context: opts, persistTranscript: true };
  }
  return {
    context: opts.context ?? 'stdout-json',
    persistTranscript: opts.persistTranscript ?? true,
  };
}

function projectHeadlessJsonRecordForTranscriptPolicy(
  record: HeadlessJsonRecord,
  context: CallConsumerContext,
  persistTranscript: boolean,
): HeadlessJsonRecord | null {
  if (record.type === 'event') {
    const event = protectEngineEventForConsumer(record.data, { context, persistTranscript });
    return event === null ? null : { type: 'event', data: event };
  }
  if (record.type !== 'recovery_required' || persistTranscript) return record;
  return { ...record, message: TRANSCRIPT_OMITTED_MESSAGE };
}

function omittedText(): string {
  return TRANSCRIPT_OMITTED_MESSAGE;
}
