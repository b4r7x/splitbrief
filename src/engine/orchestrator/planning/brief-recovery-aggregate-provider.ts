import type { RecoveryUsage } from '../../../core/schemas/brief-recovery/budget.js';
import type {
  RecoveryProviderAggregateRequest,
  RecoveryProviderAggregateResult,
  RecoveryProviderCallResult,
} from '../../../core/schemas/brief-recovery/provider-call.js';
import {
  RecoveryProviderAggregateRequestSchema,
  createRecoveryProviderAggregateResultSchema,
} from '../../../core/schemas/brief-recovery/provider-call.js';
import {
  OwnedPlannerArtifactSchema,
  TASK_BRIEF_COMPILER_POLICY,
  TASK_COMPILATION_FAILURE_CODES,
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
import { taskMergeError } from '../../spec/tasks/merge.js';
import { tasksArtifactSemanticId } from '../../spec/tasks/compiler.js';
import { formatTasks } from '../../spec/formatter.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { error } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { includes, isRecord } from '../../../utils/type-guards.js';
import { stringValue, toRecoveryUsage } from './brief-recovery-guards.js';

const AGGREGATE_PROTOCOL_ERROR: TaskCompilationFailureCode = 'task_compiler_protocol_invalid';

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

/** The merged, noncanonical Brief a fully compiled recovery program produces. */
export type RecoveryBriefCandidate = Readonly<{
  kind: 'brief-candidate';
  programId: string;
  tasksText: string;
  tasksDigest: string;
  batchCount: number;
}>;

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

function assertGlobalTaskInvariants(tasks: readonly Task[]): void {
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const task of tasks) {
    const id = String(task.id);
    if (ids.has(id)) throw taskMergeError.duplicateId(id);
    ids.add(id);
    if (files.has(task.file)) throw taskMergeError.duplicateOperation(task.file);
    files.add(task.file);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(String(dependency))) {
        throw taskMergeError.unknownDependency(String(task.id), String(dependency));
      }
    }
  }
  assertNoDependencyCycle(tasks, ids);
}

function assertNoDependencyCycle(tasks: readonly Task[], ids: ReadonlySet<string>): void {
  const byId = new Map(tasks.map((task) => [String(task.id), task] as const));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === 'done') return;
    if (current === 'visiting') throw taskMergeError.cycle([...path, id]);
    state.set(id, 'visiting');
    path.push(id);
    const task = byId.get(id);
    for (const dependency of task?.dependsOn ?? []) visit(String(dependency));
    path.pop();
    state.set(id, 'done');
  };
  for (const id of ids) visit(id);
}

function completedCall(
  frozen: RecoveryProviderAggregateRequest,
  call: RecoveryProviderAggregateRequest['calls'][number],
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

function failedCall(
  frozen: RecoveryProviderAggregateRequest,
  call: RecoveryProviderAggregateRequest['calls'][number],
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

function unknownCall(
  frozen: RecoveryProviderAggregateRequest,
  call: RecoveryProviderAggregateRequest['calls'][number],
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

function notDispatchedCall(
  frozen: RecoveryProviderAggregateRequest,
  call: RecoveryProviderAggregateRequest['calls'][number],
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
  call: RecoveryProviderAggregateRequest['calls'][number],
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

function aggregateUsage(calls: readonly RecoveryProviderCallResult[]): RecoveryUsage | null {
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

function batchEnvelopeDigest(batch: TaskCompilationProgram['batches'][number]): string {
  return sha256Hex(canonicalJSON(batch.envelope));
}

function protocolFailureResult(
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

function requestBoundResult(
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

function isAmbiguousCallStatus(
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

function failureCodeFrom(
  thrown: unknown,
  fallback: TaskCompilationFailureCode,
): TaskCompilationFailureCode {
  const candidate = isRecord(thrown)
    ? (stringValue(thrown.code) ?? stringValue(thrown.kind))
    : null;
  if (candidate !== null && includes(TASK_COMPILATION_FAILURE_CODES, candidate)) return candidate;
  return fallback;
}

function boundedFailureMessage(prefix: string, thrown: unknown): string {
  const detail = thrown instanceof Error ? thrown.message : String(thrown);
  const message = `${prefix}: ${detail}`;
  return message.slice(0, TASK_BRIEF_COMPILER_POLICY.maxDiagnosticPreviewBytes);
}

function failureFor(code: TaskCompilationFailureCode, message: string): TaskCompilationFailure {
  const trimmed = message.trim();
  return {
    code,
    message:
      trimmed.length === 0
        ? code
        : trimmed.slice(0, TASK_BRIEF_COMPILER_POLICY.maxDiagnosticPreviewBytes),
  };
}
