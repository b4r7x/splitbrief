import { z } from 'zod';
import { runnerCallWarningFingerprint } from './warning-fingerprint.js';
import {
  RUNNER_CALL_ACTIVITY_KINDS,
  RUNNER_CALL_ACTIVITY_STAGES,
  RUNNER_CALL_ARTIFACT_SOURCES,
  RUNNER_CALL_BACKEND_KINDS,
  RUNNER_CALL_CHANNELS,
  RUNNER_CALL_FAILURE_STATUSES,
  RUNNER_CALL_ROLES,
  RUNNER_CALL_STATUSES,
  RunnerCallTextChannelSchema,
  RunnerCallUsageContractSchema,
  RUNNER_CALL_WARNING_SEVERITIES,
  RUNNER_CALL_WARNING_SURFACES,
  RUNNER_CALL_USAGE_SEMANTICS,
} from '../../core/runner-call-contract.js';

export const UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH = 4096;
export const RUNNER_CALL_MESSAGE_MAX_LENGTH = 8192;

const boundedName = z.string().min(1).max(256);
const boundedId = z.string().min(1).max(128);
const boundedMessage = z.string().max(RUNNER_CALL_MESSAGE_MAX_LENGTH);
const nonnegativeInteger = z.number().int().nonnegative();
const timestampMillis = nonnegativeInteger;
const nullableSessionId = z.string().min(1).max(512).nullable();

export const RunnerCallRoleSchema = z.enum(RUNNER_CALL_ROLES);
export const RunnerCallBackendKindSchema = z.enum(RUNNER_CALL_BACKEND_KINDS);
export const RunnerCallChannelSchema = z.enum(RUNNER_CALL_CHANNELS);
export const RunnerCallStatusSchema = z.enum(RUNNER_CALL_STATUSES);
export const RunnerCallUsageSemanticsSchema = z.enum(RUNNER_CALL_USAGE_SEMANTICS);
export const RunnerCallWarningSeveritySchema = z.enum(RUNNER_CALL_WARNING_SEVERITIES);
export const RunnerCallWarningSurfaceSchema = z.enum(RUNNER_CALL_WARNING_SURFACES);
export const RunnerCallArtifactSourceSchema = z.enum(RUNNER_CALL_ARTIFACT_SOURCES);
export const RunnerCallActivityStageSchema = z.enum(RUNNER_CALL_ACTIVITY_STAGES);
export const RunnerCallActivityKindSchema = z.enum(RUNNER_CALL_ACTIVITY_KINDS);

export const RunnerCallFailureStatusSchema = z.enum(RUNNER_CALL_FAILURE_STATUSES);
export const RunnerCallTextSemanticsSchema = z.enum(['delta', 'final']);

export const CallIdSchema = boundedId;

export const runnerCallContextFields = {
  callId: CallIdSchema,
  role: RunnerCallRoleSchema,
  backendKind: RunnerCallBackendKindSchema,
  runnerName: boundedName.optional(),
  model: boundedName.optional(),
  attempt: nonnegativeInteger.optional(),
} as const;

export const RunnerCallContextSchema = z.strictObject(runnerCallContextFields);

export const RunnerCallUsageSchema = RunnerCallUsageContractSchema;

export const RunnerCallToolUseSchema = z.strictObject({
  id: boundedId.nullable(),
  name: boundedName,
  input: z.record(z.string(), z.unknown()),
  output: z.unknown().optional(),
});

export const RunnerCallArtifactSchema = z.strictObject({
  id: boundedId,
  source: RunnerCallArtifactSourceSchema,
  name: boundedName,
  path: z.string().min(1).max(2048).nullable(),
  mimeType: z.string().min(1).max(256).nullable(),
  text: z.string().nullable(),
});

export const RunnerCallErrorSchema = z.strictObject({
  code: boundedName,
  message: boundedMessage,
});

export const RunnerCallWarningSchema = z
  .strictObject({
    code: boundedName,
    severity: RunnerCallWarningSeveritySchema.default('warning'),
    source: boundedName.default('provider'),
    surface: RunnerCallWarningSurfaceSchema.default('activity'),
    parser: boundedName.optional(),
    upstreamType: boundedName.optional(),
    channel: RunnerCallChannelSchema.optional(),
    fingerprint: boundedName.optional(),
    message: boundedMessage,
    redacted: z.boolean().optional(),
    rawRef: z.string().min(1).max(512).optional(),
  })
  .transform((warning) => ({
    ...warning,
    fingerprint:
      warning.fingerprint ??
      runnerCallWarningFingerprint({
        code: warning.code,
        source: warning.source,
        message: warning.message,
      }),
  }));

const RunnerCallUnknownUpstreamBackendMetadataSchema = z.strictObject({
  backendKind: RunnerCallBackendKindSchema,
  channel: RunnerCallChannelSchema.optional(),
  source: boundedName.optional(),
  parser: boundedName.optional(),
  upstreamType: boundedName.optional(),
});

export const runnerCallTerminalFields = {
  startedAt: timestampMillis,
  endedAt: timestampMillis,
  durationMs: nonnegativeInteger,
  usage: RunnerCallUsageSchema.nullable(),
  nativeSessionId: nullableSessionId,
} as const;

function callEvent<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({
    type: z.literal(type),
    ts: timestampMillis,
    ...runnerCallContextFields,
    ...shape,
  });
}

export const RunnerCallEventSchema = z.discriminatedUnion('type', [
  callEvent('call_started', {}),
  callEvent('call_text_delta', {
    channel: RunnerCallTextChannelSchema,
    text: z.string(),
    semantics: RunnerCallTextSemanticsSchema.optional(),
  }),
  callEvent('call_stderr_delta', {
    channel: z.literal('stderr'),
    text: z.string(),
  }),
  callEvent('call_tool_use_delta', {
    channel: z.literal('tool'),
    toolUseId: boundedId.nullable(),
    name: boundedName.nullable(),
    inputDelta: z.string(),
  }),
  callEvent('call_tool_use_done', {
    channel: z.literal('tool'),
    toolUse: RunnerCallToolUseSchema,
  }),
  callEvent('call_usage', {
    usage: RunnerCallUsageSchema,
    semantics: RunnerCallUsageSemanticsSchema,
  }),
  callEvent('call_session_id', {
    nativeSessionId: z.string().min(1).max(512),
  }),
  callEvent('call_artifact', {
    artifact: RunnerCallArtifactSchema,
  }),
  callEvent('call_warning', {
    warning: RunnerCallWarningSchema,
  }),
  callEvent('call_error', {
    status: RunnerCallFailureStatusSchema,
    error: RunnerCallErrorSchema,
    partial: z.boolean(),
    ...runnerCallTerminalFields,
  }),
  callEvent('call_completed', {
    status: z.literal('completed'),
    error: z.null(),
    partial: z.literal(false),
    ...runnerCallTerminalFields,
  }),
  callEvent('call_unknown_upstream', {
    rawPreview: z.string().max(UNKNOWN_UPSTREAM_RAW_PREVIEW_MAX_LENGTH),
    backendMetadata: RunnerCallUnknownUpstreamBackendMetadataSchema,
  }),
]);

const runnerCallResultBaseFields = {
  callId: CallIdSchema,
  role: RunnerCallRoleSchema,
  backendKind: RunnerCallBackendKindSchema,
  runnerName: boundedName.optional(),
  model: boundedName.optional(),
  attempt: nonnegativeInteger.optional(),
  status: RunnerCallStatusSchema,
  startedAt: timestampMillis,
  endedAt: timestampMillis,
  durationMs: nonnegativeInteger,
  text: z.string(),
  usage: RunnerCallUsageSchema.nullable(),
  nativeSessionId: nullableSessionId,
  toolUses: z.array(RunnerCallToolUseSchema),
  artifacts: z.array(RunnerCallArtifactSchema),
  warnings: z.array(RunnerCallWarningSchema),
} as const;

const RunnerCallCompletedResultSchema = z.strictObject({
  ...runnerCallResultBaseFields,
  status: z.literal('completed'),
  error: z.null(),
  partial: z.literal(false),
});

const RunnerCallFailureResultSchema = z.strictObject({
  ...runnerCallResultBaseFields,
  status: RunnerCallFailureStatusSchema,
  error: RunnerCallErrorSchema,
  partial: z.boolean(),
});

export const RunnerCallResultSchema = z.union([
  RunnerCallCompletedResultSchema,
  RunnerCallFailureResultSchema,
]);
