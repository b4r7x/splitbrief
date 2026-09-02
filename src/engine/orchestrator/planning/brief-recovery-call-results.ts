import type { RecoveryUsage } from '../../../core/schemas/brief-recovery/budget.js';
import type {
  RecoveryProviderAggregateRequest,
  RecoveryProviderAggregateResult,
  RecoveryProviderCallResult,
} from '../../../core/schemas/brief-recovery/provider-call.js';
import { createRecoveryProviderAggregateResultSchema } from '../../../core/schemas/brief-recovery/provider-call.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  TASK_COMPILATION_FAILURE_CODES,
  type OwnedPlannerArtifact,
  type TaskCompilationFailure,
  type TaskCompilationFailureCode,
  type TaskCompilationFailureStatus,
} from '../../../core/schemas/task-compilation.js';
import { includes, isRecord } from '../../../utils/type-guards.js';
import { stringValue } from './brief-recovery-guards.js';

export const AGGREGATE_PROTOCOL_ERROR: TaskCompilationFailureCode =
  'task_compiler_protocol_invalid';

/** The merged, noncanonical Brief a fully compiled recovery program produces. */
export type RecoveryBriefCandidate = Readonly<{
  kind: 'brief-candidate';
  programId: string;
  tasksText: string;
  tasksDigest: string;
  batchCount: number;
}>;

type AggregateCall = RecoveryProviderAggregateRequest['calls'][number];

export function completedCall(
  frozen: RecoveryProviderAggregateRequest,
  call: AggregateCall,
  artifact: OwnedPlannerArtifact,
  usage: RecoveryUsage | null,
): RecoveryProviderCallResult {
  return {
    ...callIdentity(frozen, call),
    kind: 'completed',
    terminalStatus: 'completed',
    artifact,
    usage,
    failureCode: null,
  };
}

export function failedCall(
  frozen: RecoveryProviderAggregateRequest,
  call: AggregateCall,
  terminalStatus: Exclude<TaskCompilationFailureStatus, 'unknown'>,
  failureCode: TaskCompilationFailureCode,
  usage: RecoveryUsage | null,
): RecoveryProviderCallResult {
  return {
    ...callIdentity(frozen, call),
    kind: 'failed',
    terminalStatus,
    artifact: null,
    usage,
    failureCode,
  };
}

export function unknownCall(
  frozen: RecoveryProviderAggregateRequest,
  call: AggregateCall,
  failureCode: TaskCompilationFailureCode,
  usage: RecoveryUsage | null,
): RecoveryProviderCallResult {
  return {
    ...callIdentity(frozen, call),
    kind: 'unknown',
    terminalStatus: 'unknown',
    artifact: null,
    usage,
    failureCode,
  };
}

export function notDispatchedCall(
  frozen: RecoveryProviderAggregateRequest,
  call: AggregateCall,
  failureCode: TaskCompilationFailureCode,
): RecoveryProviderCallResult {
  return {
    ...callIdentity(frozen, call),
    kind: 'not-dispatched',
    artifact: null,
    usage: null,
    failureCode,
  };
}

function callIdentity(
  frozen: RecoveryProviderAggregateRequest,
  call: AggregateCall,
): Pick<
  RecoveryProviderCallResult,
  'operationId' | 'programId' | 'batchId' | 'attemptId' | 'envelopeDigest'
> {
  return {
    operationId: frozen.operationId,
    programId: frozen.program.programId,
    batchId: call.batchId,
    attemptId: call.attemptId,
    envelopeDigest: call.envelopeDigest,
  };
}

export function aggregateUsage(calls: readonly RecoveryProviderCallResult[]): RecoveryUsage | null {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const call of calls) {
    if (call.kind === 'not-dispatched') continue;
    if (call.usage === null) return null;
    inputTokens += call.usage.inputTokens;
    outputTokens += call.usage.outputTokens;
  }
  const totalTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) return null;
  return { inputTokens, outputTokens, totalTokens, estimated: false };
}

export function protocolFailureResult(
  frozen: RecoveryProviderAggregateRequest,
  detail: string,
): RecoveryProviderAggregateResult {
  const calls = frozen.calls.map((call) =>
    notDispatchedCall(frozen, call, AGGREGATE_PROTOCOL_ERROR),
  );
  return requestBoundResult(frozen, {
    kind: 'definite-failure',
    calls,
    failure: failureFor(AGGREGATE_PROTOCOL_ERROR, detail),
    usage: null,
  });
}

export function requestBoundResult(
  frozen: RecoveryProviderAggregateRequest,
  input: Readonly<{
    kind: 'compiled' | 'definite-failure' | 'ambiguous-failure';
    calls: readonly RecoveryProviderCallResult[];
    failure?: TaskCompilationFailure | undefined;
    candidate?: RecoveryBriefCandidate | undefined;
    usage: RecoveryUsage | null;
  }>,
): RecoveryProviderAggregateResult {
  return createRecoveryProviderAggregateResultSchema(frozen).parse({
    kind: input.kind,
    operationId: frozen.operationId,
    programId: frozen.program.programId,
    operationEnvelopeDigest: frozen.program.operationEnvelope.callsDigest,
    calls: input.calls,
    ...(input.kind === 'compiled' ? { candidate: input.candidate } : { failure: input.failure }),
    usage: input.usage,
  });
}

export function isAmbiguousCallStatus(
  status: TaskCompilationFailureStatus,
): status is 'aborted' | 'timeout' | 'incomplete' | 'truncated' | 'unknown' {
  return (
    status === 'aborted' ||
    status === 'timeout' ||
    status === 'incomplete' ||
    status === 'truncated' ||
    status === 'unknown'
  );
}

export function failureCodeFrom(
  thrown: unknown,
  fallback: TaskCompilationFailureCode,
): TaskCompilationFailureCode {
  const candidate = isRecord(thrown)
    ? (stringValue(thrown.code) ?? stringValue(thrown.kind))
    : null;
  if (candidate !== null && includes(TASK_COMPILATION_FAILURE_CODES, candidate)) return candidate;
  return fallback;
}

export function boundedFailureMessage(prefix: string, thrown: unknown): string {
  const detail = thrown instanceof Error ? thrown.message : String(thrown);
  const message = `${prefix}: ${detail}`;
  return message.slice(0, TASK_BRIEF_COMPILER_POLICY.maxDiagnosticPreviewBytes);
}

export function failureFor(
  code: TaskCompilationFailureCode,
  message: string,
): TaskCompilationFailure {
  const trimmed = message.trim();
  return {
    code,
    message:
      trimmed.length === 0
        ? code
        : trimmed.slice(0, TASK_BRIEF_COMPILER_POLICY.maxDiagnosticPreviewBytes),
  };
}
