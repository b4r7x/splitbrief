import { z } from 'zod';
import { PhaseSchema } from '../../../core/schemas/enums.js';
import { RunnerCallTextChannelSchema } from '../../../core/schemas/runner-call.js';
import {
  RunnerCallArtifactSchema,
  RunnerCallApiRuntimeStatusSchema,
  RunnerCallActivityKindSchema,
  RunnerCallActivityStageSchema,
  CallIdSchema,
  RUNNER_CALL_RAW_TAIL_MAX_LENGTH,
  RunnerCallErrorSchema,
  RunnerCallFailureStatusSchema,
  RunnerCallTextSemanticsSchema,
  RunnerCallToolUseSchema,
  RunnerCallUsageSchema,
  RunnerCallUsageSemanticsSchema,
  RunnerCallWarningSchema,
  runnerCallContextFields,
  runnerCallEndUnknown,
  runnerCallTerminalFields,
} from '../../calls/schema.js';

function strictCallPhaseEvent<T extends string>(type: T) {
  return z.strictObject({
    type: z.literal(type),
    ts: z.number(),
    phase: PhaseSchema,
    ...runnerCallContextFields,
    sequence: z.number().int().nonnegative(),
  });
}

const runnerCallToolUseEventBase = strictCallPhaseEvent('runner_call_tool_use');

const runnerCallToolUseEventSchema = z.discriminatedUnion('stage', [
  runnerCallToolUseEventBase.extend({
    stage: z.literal('delta'),
    toolUseId: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    inputDelta: z.string(),
  }),
  runnerCallToolUseEventBase.extend({
    stage: z.literal('done'),
    toolUse: RunnerCallToolUseSchema,
  }),
]);

export const RunnerCallEventSchemas = [
  strictCallPhaseEvent('runner_call_started'),
  strictCallPhaseEvent('runner_call_runtime_status').extend({
    runtimeStatus: RunnerCallApiRuntimeStatusSchema,
  }),
  strictCallPhaseEvent('runner_call_text_delta').extend({
    channel: RunnerCallTextChannelSchema,
    text: z.string(),
    subagentId: CallIdSchema.optional(),
    semantics: RunnerCallTextSemanticsSchema.optional(),
  }),
  strictCallPhaseEvent('runner_call_usage').extend({
    usage: RunnerCallUsageSchema,
    semantics: RunnerCallUsageSemanticsSchema,
  }),
  runnerCallToolUseEventSchema,
  strictCallPhaseEvent('runner_call_activity').extend({
    activityId: z.string().min(1).max(512),
    stage: RunnerCallActivityStageSchema,
    kind: RunnerCallActivityKindSchema,
    label: z.string().min(1).max(512),
    target: z.string().min(1).max(2048).optional(),
    /** The tool's words for a command. */
    description: z.string().min(1).max(512).optional(),
    /** How many lines of a script follow its first line. */
    moreLines: z.number().int().positive().optional(),
    redacted: z.boolean(),
    rawAvailable: z.boolean().optional(),
    expandId: z.string().min(1).max(512).optional(),
    textPartial: z.string().min(1).max(2048).optional(),
    diagnosticPartial: z.string().min(1).max(2048).optional(),
    /** Raw model ids a fallback or refusal warning names; display layers resolve them. */
    originalModel: z.string().min(1).max(256).optional(),
    fallbackModel: z.string().min(1).max(256).optional(),
    endUnknown: runnerCallEndUnknown,
  }),
  strictCallPhaseEvent('runner_call_session_id').extend({
    nativeSessionId: z.string(),
    /** The model id the tool reports it runs; `model` stays the saved seat value. */
    resolvedModel: z.string().min(1).max(256).optional(),
  }),
  strictCallPhaseEvent('runner_call_artifact').extend({
    artifact: RunnerCallArtifactSchema,
  }),
  strictCallPhaseEvent('runner_call_warning').extend({
    warning: RunnerCallWarningSchema,
  }),
  strictCallPhaseEvent('runner_call_error').extend({
    status: RunnerCallFailureStatusSchema,
    error: RunnerCallErrorSchema,
    partial: z.boolean(),
    rawTail: z.string().max(RUNNER_CALL_RAW_TAIL_MAX_LENGTH).optional(),
    ...runnerCallTerminalFields,
    endUnknown: runnerCallEndUnknown,
  }),
  strictCallPhaseEvent('runner_call_completed').extend({
    status: z.literal('completed'),
    error: z.null(),
    partial: z.literal(false),
    ...runnerCallTerminalFields,
  }),
  strictCallPhaseEvent('runner_call_stalled').extend({
    silentMs: z.number().int().nonnegative(),
  }),
  strictCallPhaseEvent('runner_call_stall_cleared'),
  strictCallPhaseEvent('runner_call_heartbeat'),
] as const;
