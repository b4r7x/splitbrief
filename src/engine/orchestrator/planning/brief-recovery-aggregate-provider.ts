import type {
  RecoveryProviderAggregateRequest,
  RecoveryProviderAggregateResult,
  RecoveryProviderCallResult,
} from '../../../core/schemas/brief-recovery/provider-call.js';
import { RecoveryProviderAggregateRequestSchema } from '../../../core/schemas/brief-recovery/provider-call.js';
import {
  OwnedPlannerArtifactSchema,
  TASK_BRIEF_COMPILER_POLICY,
  type OwnedPlannerArtifact,
  type TaskCompilationAttemptId,
  type TaskCompilationFailure,
  type TaskCompilationFailureCode,
  type TaskCompilationFailureStatus,
  type TaskCompilationProgram,
  type PlannerSessionScope,
} from '../../../core/schemas/task-compilation.js';
import type { Task } from '../../../core/schemas/task.js';
import { formatTaskId } from '../../../core/schemas/task.js';
import type { TaskDispatchLedger } from '../../calls/dispatch-ledger.js';
import type { PlannerInvokeResult } from '../../planners/types.js';
import type { PreparedPlannerInvocation } from '../../runners/types.js';
import { admitTaskBatch } from '../../spec/tasks/batch-admission.js';
import { assertGlobalTaskInvariants } from '../../spec/tasks/invariants.js';
import { taskMergeError } from '../../spec/tasks/merge.js';
import { tasksArtifactSemanticId } from '../../spec/tasks/compiler.js';
import { formatTasks } from '../../spec/formatter.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { error } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';
import {
  aggregateUsage,
  boundedFailureMessage,
  completedCall,
  failedCall,
  failureCodeFrom,
  failureFor,
  isAmbiguousCallStatus,
  notDispatchedCall,
  protocolFailureResult,
  requestBoundResult,
  unknownCall,
  type RecoveryBriefCandidate,
} from './brief-recovery-call-results.js';
import { toRecoveryUsage } from './brief-recovery-guards.js';

const TERMINAL_FAILURE_CODES: Record<TaskCompilationFailureStatus, TaskCompilationFailureCode> = {
  failed: 'task_compiler_provider_failed',
  refused: 'task_compiler_provider_refused',
  unsupported_tool: 'task_compiler_capability_unsupported',
  incomplete: 'task_compiler_output_limited',
  cancelled: 'task_compiler_cancelled',
  aborted: 'task_compiler_cancelled',
  timeout: 'task_compiler_timeout',
  truncated: 'task_compiler_output_limited',
  'protocol-invalid': 'task_compiler_protocol_invalid',
  unknown: 'task_compiler_provider_failed',
};

/** The production dispatch seam: one detached-fresh batch invoke, no claim. */
export type RecoveryAggregateBatchDispatch = (
  input: Readonly<{
    attemptId: TaskCompilationAttemptId;
    batch: TaskCompilationProgram['batches'][number];
    sessionScope: PlannerSessionScope;
    projectDir: string;
  }>,
) => Promise<PlannerInvokeResult>;

export type RecoveryAggregateProviderOptions = Readonly<{
  ledger: TaskDispatchLedger;
  invocation: PreparedPlannerInvocation;
  dispatch: RecoveryAggregateBatchDispatch;
  projectDir: string;
}>;

export type RecoveryAggregateProvider = Readonly<{
  dispatch(request: RecoveryProviderAggregateRequest): Promise<RecoveryProviderAggregateResult>;
}>;

/**
 * The aggregate recovery provider dispatches a frozen program's preauthorized
 * batches sequentially. Every actual invoke is preceded by a ledger claim, so
 * replay, continuation, and concurrent owners can never dispatch an attempt
 * twice or pass the operation envelope's dispatch ceiling. The first failure
 * or unknown outcome stops all later dispatches; the complete candidate is
 * merged only after every batch completed and its merged Tasks hold globally.
 */
export function createBriefRecoveryAggregateProvider(
  options: RecoveryAggregateProviderOptions,
): RecoveryAggregateProvider {
  return {
    dispatch: (request) => dispatchRecoveryProgram(request, options),
  };
}

async function dispatchRecoveryProgram(
  request: RecoveryProviderAggregateRequest,
  options: RecoveryAggregateProviderOptions,
): Promise<RecoveryProviderAggregateResult> {
  const parsed = RecoveryProviderAggregateRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw error('brief-recovery-input-invalid', 'The aggregate recovery request is invalid.', {
      detail: parsed.error.message.slice(0, TASK_BRIEF_COMPILER_POLICY.maxDiagnosticPreviewBytes),
    });
  }
  const frozen = parsed.data;
  const ledgerSnapshot = options.ledger.snapshot();
  if (
    ledgerSnapshot.operationId !== frozen.operationId ||
    ledgerSnapshot.dispatchLimit !== frozen.program.operationEnvelope.dispatchLimit
  ) {
    return protocolFailureResult(
      frozen,
      'the dispatch ledger is bound to a different operation or envelope',
    );
  }
  const batchBySelection = new Map(
    frozen.program.batches.map((batch) => [batch.batchId, batch] as const),
  );
  for (const call of frozen.calls) {
    const batch = batchBySelection.get(call.batchId);
    if (batch === undefined || call.envelopeDigest !== batchEnvelopeDigest(batch)) {
      return protocolFailureResult(
        frozen,
        `call for batch ${call.batchId} does not match the frozen program envelope`,
      );
    }
  }

  const calls: RecoveryProviderCallResult[] = [];
  let stopFailure: TaskCompilationFailure | null = null;
  for (const call of frozen.calls) {
    if (stopFailure !== null) {
      calls.push(notDispatchedCall(frozen, call, stopFailure.code));
      continue;
    }
    const batch = batchBySelection.get(call.batchId);
    if (batch === undefined) {
      return protocolFailureResult(frozen, `batch ${call.batchId} is missing from the program`);
    }
    const claim = options.ledger.claimDispatch(call.attemptId);
    if (claim.kind === 'refused') {
      const code =
        claim.reason === 'attempt-already-claimed'
          ? 'task_compiler_continuation_forbidden'
          : 'task_compiler_dispatch_limit';
      calls.push(notDispatchedCall(frozen, call, code));
      stopFailure = failureFor(
        code,
        claim.reason === 'attempt-already-claimed'
          ? `attempt ${call.attemptId} was already dispatched by this operation`
          : `the operation dispatch ceiling is reached (${claim.dispatchCount}/${claim.dispatchLimit})`,
      );
      continue;
    }
    const outcome = await dispatchOneCall({ frozen, call, batch, options });
    calls.push(outcome.call);
    if (outcome.stop !== null) stopFailure = outcome.stop;
  }

  const usage = aggregateUsage(calls);
  if (stopFailure === null) {
    try {
      const candidate = mergeBriefCandidate(frozen, calls);
      return requestBoundResult(frozen, {
        kind: 'compiled',
        calls,
        candidate,
        usage,
      });
    } catch (thrown) {
      stopFailure = failureFor(
        failureCodeFrom(thrown, 'task_compiler_invalid_markdown'),
        boundedFailureMessage('the merged Brief candidate is invalid', thrown),
      );
    }
  }
  const hasUnknown = calls.some((call) => call.kind === 'unknown');
  return requestBoundResult(frozen, {
    kind: hasUnknown ? 'ambiguous-failure' : 'definite-failure',
    calls,
    failure: stopFailure,
    usage,
  });
}

async function dispatchOneCall(
  input: Readonly<{
    frozen: RecoveryProviderAggregateRequest;
    call: RecoveryProviderAggregateRequest['calls'][number];
    batch: TaskCompilationProgram['batches'][number];
    options: RecoveryAggregateProviderOptions;
  }>,
): Promise<{
  call: RecoveryProviderCallResult;
  stop: TaskCompilationFailure | null;
}> {
  const { frozen, call, batch, options } = input;
  const sessionScope: PlannerSessionScope = {
    kind: 'detached-fresh',
    operationId: frozen.operationId,
    programId: frozen.program.programId,
    batchId: batch.batchId,
    attemptId: call.attemptId,
  };
  let result: PlannerInvokeResult;
  try {
    result = await options.dispatch({
      attemptId: call.attemptId,
      batch,
      sessionScope,
      projectDir: options.projectDir,
    });
  } catch (thrown) {
    const failure = failureFor(
      'task_compiler_provider_failed',
      boundedFailureMessage('the batch dispatch failed', thrown),
    );
    return { call: unknownCall(frozen, call, failure.code, null), stop: failure };
  }
  if (result.status === 'completed') {
    let artifact: OwnedPlannerArtifact;
    try {
      artifact = buildOwnedArtifact({ frozen, call, batch, options, result });
    } catch (thrown) {
      const code = failureCodeFrom(thrown, 'task_compiler_provider_failed');
      const failure = failureFor(
        code,
        boundedFailureMessage('the call artifact is invalid', thrown),
      );
      return {
        call: failedCall(frozen, call, 'protocol-invalid', code, toRecoveryUsage(result.usage)),
        stop: failure,
      };
    }
    return {
      call: completedCall(frozen, call, artifact, toRecoveryUsage(result.usage)),
      stop: null,
    };
  }
  const code = result.failureCode ?? TERMINAL_FAILURE_CODES[result.status];
  const failure = failureFor(
    code,
    `batch ${batch.batchId} ended with terminal status ${result.status}`,
  );
  if (isAmbiguousCallStatus(result.status)) {
    return { call: unknownCall(frozen, call, code, toRecoveryUsage(result.usage)), stop: failure };
  }
  return {
    call: failedCall(frozen, call, result.status, code, toRecoveryUsage(result.usage)),
    stop: failure,
  };
}

function buildOwnedArtifact(
  input: Readonly<{
    frozen: RecoveryProviderAggregateRequest;
    call: RecoveryProviderAggregateRequest['calls'][number];
    batch: TaskCompilationProgram['batches'][number];
    options: RecoveryAggregateProviderOptions;
    result: PlannerInvokeResult;
  }>,
): OwnedPlannerArtifact {
  const { frozen, call, batch, options, result } = input;
  const transport = options.invocation.transport;
  const text = result.text;
  const semanticId = tasksArtifactSemanticId(frozen.program.programId);
  const sourceReceipt =
    transport.kind === 'stdout-final'
      ? { kind: 'stdout-final' as const, resultDigest: sha256Hex(text) }
      : declaredFileSourceReceipt({ frozen, call, batch, result, semanticId });
  return OwnedPlannerArtifactSchema.parse({
    semanticId,
    programId: frozen.program.programId,
    batchId: batch.batchId,
    attemptId: call.attemptId,
    logicalName: 'tasks.md',
    transport: transport.kind,
    text,
    byteLength: Buffer.byteLength(text, 'utf8'),
    sha256: sha256Hex(text),
    runtimeReceipt: options.invocation.runtime.runtimeDigest,
    terminal: {
      status: 'completed',
      recordId: call.attemptId,
      protocolDigest: options.invocation.runtime.protocolDigest,
    },
    sourceReceipt,
  });
}

function declaredFileSourceReceipt(
  input: Readonly<{
    frozen: RecoveryProviderAggregateRequest;
    call: RecoveryProviderAggregateRequest['calls'][number];
    batch: TaskCompilationProgram['batches'][number];
    result: PlannerInvokeResult;
    semanticId: string;
  }>,
): Extract<OwnedPlannerArtifact['sourceReceipt'], { kind: 'declared-file' }> {
  const { frozen, call, batch, result, semanticId } = input;
  const receipt = result.ownedArtifactReceipt;
  if (receipt === undefined) {
    throw error(
      'task_compiler_artifact_invalid',
      'the adapter returned no lease receipt for the declared-file transport',
    );
  }
  if (receipt.attemptId !== call.attemptId) {
    throw error(
      'task_compiler_artifact_invalid',
      'the lease receipt binds a different attempt identity',
    );
  }
  if (receipt.batchId !== batch.batchId) {
    throw error(
      'task_compiler_artifact_invalid',
      'the lease receipt binds a different batch identity',
    );
  }
  if (receipt.programId !== frozen.program.programId) {
    throw error(
      'task_compiler_artifact_invalid',
      'the lease receipt binds a different program identity',
    );
  }
  if (receipt.semanticId !== semanticId) {
    throw error(
      'task_compiler_artifact_invalid',
      'the lease receipt binds a different semantic identity',
    );
  }
  return {
    kind: 'declared-file',
    leaseId: receipt.leaseId,
    inodeIdentity: receipt.inodeIdentity,
    leaseReceiptDigest: receipt.leaseReceiptDigest,
  };
}

function mergeBriefCandidate(
  frozen: RecoveryProviderAggregateRequest,
  calls: readonly RecoveryProviderCallResult[],
): RecoveryBriefCandidate {
  const batchBySelection = new Map(
    frozen.program.batches.map((batch) => [batch.batchId, batch] as const),
  );
  const tasks: Task[] = [];
  for (const call of calls) {
    if (call.kind !== 'completed') continue;
    const batch = batchBySelection.get(call.batchId);
    if (batch === undefined) {
      throw taskMergeError.invalidManifest(
        `batch ${call.batchId} is not part of the frozen program`,
      );
    }
    // The manifest item ids are stable ordinals of the program partition
    // (T001..TNNN), so the frozen batch's manifestOrdinals bind the exact
    // membership this batch may return.
    const expectedIds = batch.manifestOrdinals.map((ordinal) => formatTaskId(ordinal + 1));
    tasks.push(...admitTaskBatch(call.artifact.text, { expectedIds }));
  }
  assertGlobalTaskInvariants(tasks);
  const tasksText = formatTasks(tasks);
  return {
    kind: 'brief-candidate',
    programId: frozen.program.programId,
    tasksText,
    tasksDigest: sha256Hex(tasksText),
    batchCount: calls.length,
  };
}

function batchEnvelopeDigest(batch: TaskCompilationProgram['batches'][number]): string {
  return sha256Hex(canonicalJSON(batch.envelope));
}
