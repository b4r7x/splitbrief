import { z } from 'zod';

export const RUNNER_CALL_ROLES = [
  'planner',
  'implementer',
  'review',
  'summary',
  'compaction',
  'escalation',
] as const;

export const RUNNER_CALL_BACKEND_KINDS = ['cli', 'shell', 'api', 'agent', 'agent-sdk'] as const;

export const RUNNER_CALL_CHANNELS = [
  'stdout',
  'stderr',
  'assistant',
  'result',
  'tool',
  'system',
] as const;

export const RUNNER_CALL_STATUSES = [
  'completed',
  'failed',
  'truncated',
  'aborted',
  'timeout',
  'refused',
  'unsupported_tool',
  'incomplete',
] as const;

export const RUNNER_CALL_FAILURE_STATUSES = [
  'failed',
  'truncated',
  'aborted',
  'timeout',
  'refused',
  'unsupported_tool',
  'incomplete',
] as const;

export const RUNNER_CALL_USAGE_SEMANTICS = ['delta', 'cumulative', 'final'] as const;
export const RUNNER_CALL_ARTIFACT_SOURCES = ['stream', 'file', 'tool', 'derived'] as const;

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
export const RunnerCallArtifactSourceSchema = z.enum(RUNNER_CALL_ARTIFACT_SOURCES);

export const RunnerCallFailureStatusSchema = z.enum(RUNNER_CALL_FAILURE_STATUSES);
const RunnerCallTextChannelSchema = z.enum(['stdout', 'assistant', 'result', 'system']);

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

export const RunnerCallUsageSchema = z.strictObject({
  inputTokens: nonnegativeInteger,
  outputTokens: nonnegativeInteger,
  cacheReadTokens: nonnegativeInteger.optional(),
  cacheCreateTokens: nonnegativeInteger.optional(),
  reasoningTokens: nonnegativeInteger.optional(),
});

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

export const RunnerCallWarningSchema = z.strictObject({
  code: boundedName,
  message: boundedMessage,
});

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
