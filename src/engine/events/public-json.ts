import { z } from 'zod';
import { TaskIdSchema } from '../../core/schemas/task.js';
import {
  RecoveryActionSchema,
  RecoveryReasonSchema,
  RecoveryStatusSchema,
} from '../../core/schemas/enums.js';
import {
  type BriefRecoveryProjectionV1,
  BriefRecoveryProjectionV1Schema,
} from '../../core/schemas/brief-recovery/document.js';
import {
  type RecoveryResultV1,
  RecoveryResultV1Schema,
} from '../../core/schemas/brief-recovery.js';
import type { BriefQualityIssue } from '../../core/schemas/brief-recovery/primitives.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { protectConsumerPayload, type CallConsumerContext } from '../../core/consumer-policy.js';
import { EngineEventSchema } from './schema.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../core/transcript-policy.js';
import { protectEngineEventForConsumer } from './protection/protect.js';

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
    type: z.literal('brief_recovery'),
    projection: BriefRecoveryProjectionV1Schema,
  }),
  z.strictObject({
    type: z.literal('brief_recovery_result'),
    result: RecoveryResultV1Schema,
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

export function protectBriefRecoveryProjectionForConsumer(
  projection: BriefRecoveryProjectionV1,
  opts: ProtectHeadlessJsonRecordOptions = {},
): BriefRecoveryProjectionV1 | null {
  const { context, persistTranscript } = resolveProtectHeadlessOptions(opts);
  const parsed = BriefRecoveryProjectionV1Schema.safeParse(projection);
  if (!parsed.success) return null;
  return protectRecoveryValue(
    projectBriefRecoveryProjectionForTranscriptPolicy(parsed.data, persistTranscript),
    BriefRecoveryProjectionV1Schema,
    context,
  );
}

export function protectRecoveryResultForConsumer(
  result: RecoveryResultV1,
  opts: ProtectHeadlessJsonRecordOptions = {},
): RecoveryResultV1 | null {
  const { context, persistTranscript } = resolveProtectHeadlessOptions(opts);
  const parsed = RecoveryResultV1Schema.safeParse(result);
  if (!parsed.success) return null;
  return protectRecoveryValue(
    projectRecoveryResultForTranscriptPolicy(parsed.data, persistTranscript),
    RecoveryResultV1Schema,
    context,
  );
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
  opts: ProtectHeadlessJsonRecordOptions = {},
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

function resolveProtectHeadlessOptions(opts: ProtectHeadlessJsonRecordOptions): {
  context: CallConsumerContext;
  persistTranscript: boolean;
} {
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
  if (record.type === 'brief_recovery') {
    const projection = protectBriefRecoveryProjectionForConsumer(record.projection, {
      context,
      persistTranscript,
    });
    return projection === null ? record : { type: 'brief_recovery', projection };
  }
  if (record.type === 'brief_recovery_result') {
    const result = protectRecoveryResultForConsumer(record.result, {
      context,
      persistTranscript,
    });
    return result === null ? record : { type: 'brief_recovery_result', result };
  }
  if (record.type !== 'recovery_required' || persistTranscript) return record;
  return { ...record, message: TRANSCRIPT_OMITTED_MESSAGE };
}

function protectRecoveryValue<T>(
  value: T,
  schema: z.ZodType<T>,
  context: CallConsumerContext,
): T | null {
  const protectedPayload = protectConsumerPayload({ context, payload: value });
  if (protectedPayload.oversized) return null;
  const parsed = schema.safeParse(protectedPayload.payload);
  return parsed.success ? parsed.data : null;
}

function projectBriefRecoveryProjectionForTranscriptPolicy(
  projection: BriefRecoveryProjectionV1,
  persistTranscript: boolean,
): BriefRecoveryProjectionV1 {
  if (persistTranscript) return projection;
  return {
    ...projection,
    matchingReport:
      projection.matchingReport === null
        ? null
        : {
            ...projection.matchingReport,
            issues: projection.matchingReport.issues.map(projectBriefIssueForTranscriptPolicy),
          },
    blocker: projectBriefBlockerForTranscriptPolicy(projection.blocker),
  };
}

function projectRecoveryResultForTranscriptPolicy(
  result: RecoveryResultV1,
  persistTranscript: boolean,
): RecoveryResultV1 {
  const projection = projectBriefRecoveryProjectionForTranscriptPolicy(
    result.projection,
    persistTranscript,
  );
  if (persistTranscript) return { ...result, projection };
  if (!('reason' in result)) return { ...result, projection };
  return { ...result, projection, reason: TRANSCRIPT_OMITTED_MESSAGE };
}

function projectBriefIssueForTranscriptPolicy(issue: BriefQualityIssue): BriefQualityIssue {
  return { ...issue, message: TRANSCRIPT_OMITTED_MESSAGE };
}

function projectBriefBlockerForTranscriptPolicy(
  blocker: BriefRecoveryProjectionV1['blocker'],
): BriefRecoveryProjectionV1['blocker'] {
  if (blocker === null) return null;
  switch (blocker.kind) {
    case 'quality':
      return {
        ...blocker,
        issues: blocker.issues.map(projectBriefIssueForTranscriptPolicy),
      };
    case 'provider':
    case 'storage':
      return { ...blocker, message: TRANSCRIPT_OMITTED_MESSAGE };
    case 'budget':
    case 'no-progress':
    case 'unresolved':
      return blocker;
    default: {
      const exhaustive: never = blocker;
      return exhaustive;
    }
  }
}

function omittedText(): string {
  return TRANSCRIPT_OMITTED_MESSAGE;
}
