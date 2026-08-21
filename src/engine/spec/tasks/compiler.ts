import {
  CallEnvelopeSchema,
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationProgramSchema,
  TaskCompilationSemanticIdSchema,
  type OwnedPlannerArtifact,
  type TaskCompilationAttemptId,
  type TaskCompilationCallEnvelope,
  type TaskCompilationFailureCode,
  type TaskCompilationFailureStatus,
  type TaskCompilationOperationId,
  type TaskCompilationPolicy,
  type TaskCompilationProgram,
  type TaskCompilationProgramId,
  type TaskCompilationSemanticId,
  type TaskCompilationSessionScope,
} from '../../../core/schemas/task-compilation.js';
import type { Task } from '../../../core/schemas/task.js';
import type { TaskDispatchLedger } from '../../calls/dispatch-ledger.js';
import type { PlannerInvokeResult } from '../../planners/types.js';
import type { PreparedPlannerInvocation } from '../../runners/types.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { error, matches } from '../../../utils/error.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { buildLanguageContext } from '../prompts/language-context.js';
import { buildTaskBatchPrompt } from '../prompts/tasks.js';
import { admitTaskBatch } from './blocks.js';
import { parseTaskManifest, type TaskManifest } from './manifest.js';
import { mergeTaskResult, type TaskMergeResult } from './merge.js';
import { partitionManifest, type TaskManifestPartition } from './partition.js';

export type TaskCompilerInputs = Readonly<{
  spec: string;
  plan: string;
  languageContext?: string;
  repairSubject?: string | null;
}>;

export type TaskCompilationMaterializeOptions = Readonly<{
  envelope: TaskCompilationCallEnvelope;
  policy?: TaskCompilationPolicy;
}>;

export type TaskCompilerBatchDispatch = (
  input: Readonly<{
    attemptId: TaskCompilationAttemptId;
    batch: TaskCompilationProgram['batches'][number];
    sessionScope: TaskCompilationSessionScope;
    ledger: TaskDispatchLedger;
  }>,
) => Promise<PlannerInvokeResult>;

export type TaskCompilerOptions = Readonly<{
  inputs: TaskCompilerInputs;
  invocation: PreparedPlannerInvocation;
  ledger: TaskDispatchLedger;
  dispatch: TaskCompilerBatchDispatch;
  policy?: TaskCompilationPolicy;
}>;

export type TaskCompilationCandidate = Readonly<{
  kind: 'compiled';
  program: TaskCompilationProgram;
  manifest: TaskManifest;
  artifacts: readonly OwnedPlannerArtifact[];
  merge: TaskMergeResult;
}>;

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

export const compilerError = {
  protocolInvalid: (detail: string, batchOrdinal: number) =>
    error('task_compiler_protocol_invalid', `The compiler call protocol is invalid: ${detail}`, {
      detail,
      batchOrdinal,
    }),
  dispatchLimit: (count: number, limit: number, batchOrdinal: number) =>
    error(
      'task_compiler_dispatch_limit',
      `The operation dispatch ceiling is exhausted (${count}/${limit}) before batch ${batchOrdinal + 1}.`,
      { count, limit, batchOrdinal },
    ),
  terminalFailure: (status: TaskCompilationFailureStatus, batchOrdinal: number) =>
    error(
      TERMINAL_FAILURE_CODES[status],
      `Batch ${batchOrdinal + 1} ended with terminal status ${status}; no batch bytes can be admitted.`,
      { status, batchOrdinal },
    ),
  oversizedArtifact: (byteLength: number, limit: number, batchOrdinal: number) =>
    error(
      'task_compiler_output_limited',
      `Batch ${batchOrdinal + 1} final response is ${byteLength} bytes; the artifact bound is ${limit} bytes.`,
      { byteLength, limit, batchOrdinal },
    ),
  artifactInvalid: (detail: string, batchOrdinal: number) =>
    error(
      'task_compiler_artifact_invalid',
      `Batch ${batchOrdinal + 1} declared-file receipt is invalid: ${detail}`,
      { detail, batchOrdinal },
    ),
  providerFailed: (cause: unknown, batchOrdinal: number) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    const limit = TASK_BRIEF_COMPILER_POLICY.maxDiagnosticPreviewBytes;
    const detail = message.length > limit ? `${message.slice(0, limit - 3)}...` : message;
    return error(
      'task_compiler_provider_failed',
      `Batch ${batchOrdinal + 1} dispatch failed: ${detail}`,
      {
        detail,
        batchOrdinal,
      },
    );
  },
  isDispatchLimit: matches('task_compiler_dispatch_limit'),
  isProtocolInvalid: matches('task_compiler_protocol_invalid'),
  isArtifactInvalid: matches('task_compiler_artifact_invalid'),
} as const;

export function tasksArtifactSemanticId(
  programId: TaskCompilationProgramId,
): TaskCompilationSemanticId {
  return TaskCompilationSemanticIdSchema.parse(`tasks-${programId}`);
}

export function materializeTaskCompilationProgram(
  inputs: TaskCompilerInputs,
  options: TaskCompilationMaterializeOptions,
): TaskCompilationProgram {
  return materialize(inputs, options).program;
}

export async function compileTaskBriefs(
  options: TaskCompilerOptions,
): Promise<TaskCompilationCandidate> {
  const policy = options.policy ?? TASK_BRIEF_COMPILER_POLICY;
  const { manifest, partition, program } = materialize(options.inputs, {
    envelope: options.invocation.envelope,
    policy,
  });
  const ledgerSnapshot = options.ledger.snapshot();
  if (ledgerSnapshot.dispatchLimit !== program.operationEnvelope.dispatchLimit) {
    throw compilerError.protocolInvalid(
      'the dispatch ledger is bound to a different operation than the materialized program',
      0,
    );
  }
  const operationId = ledgerSnapshot.operationId;
  const semanticId = tasksArtifactSemanticId(program.programId);

  const artifacts: OwnedPlannerArtifact[] = [];
  const admittedTasks: Task[] = [];
  for (let index = 0; index < program.batches.length; index += 1) {
    const batch = program.batches[index];
    const partitionBatch = partition.batches[index];
    if (batch === undefined || partitionBatch === undefined) {
      throw compilerError.protocolInvalid(`materialized batch ${index} is missing`, index);
    }
    if (partitionBatch.batchId !== batch.batchId) {
      throw compilerError.protocolInvalid(`materialized batch ${index} identity changed`, index);
    }
    const attemptId = createTaskCompilationAttemptId();
    const result = await invokeBatch(options.dispatch, {
      attemptId,
      batch,
      index,
      operationId,
      programId: program.programId,
      ledger: options.ledger,
    });
    if (result.status !== 'completed') {
      if (result.status === 'refused' && result.error?.code === 'task_compiler_dispatch_limit') {
        const snapshot = options.ledger.snapshot();
        throw compilerError.dispatchLimit(snapshot.dispatchCount, snapshot.dispatchLimit, index);
      }
      throw compilerError.terminalFailure(result.status, index);
    }
    if (result.attemptId !== undefined && result.attemptId !== attemptId) {
      throw compilerError.protocolInvalid(
        'the result attempt identity does not match the claimed batch attempt',
        index,
      );
    }
    assertArtifactWithinBound(result.text, policy, index);
    const artifact = createOwnedArtifact({
      semanticId,
      programId: program.programId,
      batch,
      batchOrdinal: index,
      attemptId,
      invocation: options.invocation,
      result,
    });
    const tasks = admitTaskBatch(result.text, { batch: partitionBatch });
    artifacts.push(artifact);
    admittedTasks.push(...tasks);
  }

  return {
    kind: 'compiled',
    program,
    manifest,
    artifacts: Object.freeze(artifacts),
    merge: mergeTaskResult(manifest, admittedTasks),
  };
}

type MaterializedProgram = Readonly<{
  manifest: TaskManifest;
  partition: TaskManifestPartition;
  program: TaskCompilationProgram;
}>;

function materialize(
  inputs: TaskCompilerInputs,
  options: TaskCompilationMaterializeOptions,
): MaterializedProgram {
  const policy = options.policy ?? TASK_BRIEF_COMPILER_POLICY;
  const envelope = CallEnvelopeSchema.safeParse(options.envelope);
  if (!envelope.success)
    throw compilerError.protocolInvalid('call envelope is outside the compiler policy', 0);
  const manifest = parseTaskManifest(inputs.plan, policy);
  const partition = partitionManifest(manifest, inputs, policy);
  const languageContext = buildLanguageContext(inputs.languageContext);

  const batches = partition.batches.map((batch) => {
    const backwardDependencies = partition.batches
      .slice(0, batch.ordinal)
      .flatMap((earlier) => earlier.items);
    const prompt = buildTaskBatchPrompt(
      { programId: partition.programId, batch, backwardDependencies },
      { languageContext, envelope: envelope.data },
    );
    return {
      batchId: batch.batchId,
      manifestOrdinals: batch.manifestOrdinals,
      prompt,
      envelope: { ...envelope.data, promptBytes: Buffer.byteLength(prompt, 'utf8') },
    };
  });

  const inputDigests = {
    spec: sha256Hex(inputs.spec),
    plan: sha256Hex(inputs.plan),
    languageContext: sha256Hex(inputs.languageContext ?? ''),
    repairSubject: inputs.repairSubject == null ? null : sha256Hex(inputs.repairSubject),
  };
  const operationEnvelope = {
    version: 1,
    dispatchLimit: policy.maxDispatches,
    callCount: batches.length,
    totalPromptBytes: sumOf(batches, (batch) => batch.envelope.promptBytes),
    totalInputTokensUpperBound: sumOf(batches, (batch) => batch.envelope.inputTokensUpperBound),
    totalOutputTokensUpperBound: sumOf(batches, (batch) => batch.envelope.outputTokensUpperBound),
    totalNormalizedOutputBytes: sumOf(batches, (batch) => batch.envelope.maxNormalizedOutputBytes),
    totalDeclaredArtifactBytes: sumOf(batches, (batch) => batch.envelope.maxDeclaredArtifactBytes),
    callsDigest: sha256Hex(
      canonicalJSON({
        policyVersion: policy.version,
        programId: partition.programId,
        manifestDigest: manifest.manifestDigest,
        inputDigests,
        batches,
      }),
    ),
  };

  const program = TaskCompilationProgramSchema.parse({
    policyVersion: policy.version,
    programId: partition.programId,
    manifestDigest: manifest.manifestDigest,
    inputDigests,
    batches,
    operationEnvelope,
  });
  return { manifest, partition, program };
}

function sumOf(
  batches: ReadonlyArray<{
    envelope: TaskCompilationCallEnvelope;
  }>,
  pick: (batch: { envelope: TaskCompilationCallEnvelope }) => number,
): number {
  return batches.reduce((total, batch) => total + pick(batch), 0);
}

async function invokeBatch(
  dispatch: TaskCompilerBatchDispatch,
  input: Readonly<{
    attemptId: TaskCompilationAttemptId;
    batch: TaskCompilationProgram['batches'][number];
    index: number;
    operationId: TaskCompilationOperationId;
    programId: TaskCompilationProgramId;
    ledger: TaskDispatchLedger;
  }>,
): Promise<PlannerInvokeResult> {
  try {
    return await dispatch({
      attemptId: input.attemptId,
      batch: input.batch,
      sessionScope: {
        kind: 'detached-fresh',
        operationId: input.operationId,
        programId: input.programId,
        batchId: input.batch.batchId,
        attemptId: input.attemptId,
      },
      ledger: input.ledger,
    });
  } catch (err) {
    throw compilerError.providerFailed(err, input.index);
  }
}

function createOwnedArtifact(
  input: Readonly<{
    semanticId: TaskCompilationSemanticId;
    programId: TaskCompilationProgramId;
    batch: TaskCompilationProgram['batches'][number];
    batchOrdinal: number;
    attemptId: TaskCompilationAttemptId;
    invocation: PreparedPlannerInvocation;
    result: PlannerInvokeResult;
  }>,
): OwnedPlannerArtifact {
  const { semanticId, programId, batch, batchOrdinal, attemptId, invocation, result } = input;
  const transport = invocation.transport;
  const text = result.text;
  const sourceReceipt =
    transport.kind === 'stdout-final'
      ? { kind: 'stdout-final' as const, resultDigest: sha256Hex(text) }
      : declaredFileSourceReceipt({
          semanticId,
          programId,
          batch,
          batchOrdinal,
          attemptId,
          result,
        });
  return OwnedPlannerArtifactSchema.parse({
    semanticId,
    programId,
    batchId: batch.batchId,
    attemptId,
    logicalName: 'tasks.md',
    transport: transport.kind,
    text,
    byteLength: Buffer.byteLength(text, 'utf8'),
    sha256: sha256Hex(text),
    runtimeReceipt: invocation.runtime.runtimeDigest,
    terminal: {
      status: 'completed',
      recordId: attemptId,
      protocolDigest: invocation.runtime.protocolDigest,
    },
    sourceReceipt,
  });
}

function declaredFileSourceReceipt(
  input: Readonly<{
    semanticId: TaskCompilationSemanticId;
    programId: TaskCompilationProgramId;
    batch: TaskCompilationProgram['batches'][number];
    batchOrdinal: number;
    attemptId: TaskCompilationAttemptId;
    result: PlannerInvokeResult;
  }>,
): Extract<OwnedPlannerArtifact['sourceReceipt'], { kind: 'declared-file' }> {
  const { semanticId, programId, batch, batchOrdinal, attemptId, result } = input;
  const receipt = result.ownedArtifactReceipt;
  if (receipt === undefined) {
    throw compilerError.artifactInvalid(
      'the adapter returned no lease receipt for the declared-file transport',
      batchOrdinal,
    );
  }
  if (receipt.attemptId !== attemptId) {
    throw compilerError.artifactInvalid(
      'the lease receipt binds a different attempt identity',
      batchOrdinal,
    );
  }
  if (receipt.batchId !== batch.batchId) {
    throw compilerError.artifactInvalid(
      'the lease receipt binds a different batch identity',
      batchOrdinal,
    );
  }
  if (receipt.programId !== programId) {
    throw compilerError.artifactInvalid(
      'the lease receipt binds a different program identity',
      batchOrdinal,
    );
  }
  if (receipt.semanticId !== semanticId) {
    throw compilerError.artifactInvalid(
      'the lease receipt binds a different semantic identity',
      batchOrdinal,
    );
  }
  return {
    kind: 'declared-file',
    leaseId: receipt.leaseId,
    inodeIdentity: receipt.inodeIdentity,
    leaseReceiptDigest: receipt.leaseReceiptDigest,
  };
}

function assertArtifactWithinBound(
  text: string,
  policy: TaskCompilationPolicy,
  batchOrdinal: number,
): void {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > policy.maxDeclaredArtifactBytes) {
    throw compilerError.oversizedArtifact(
      byteLength,
      policy.maxDeclaredArtifactBytes,
      batchOrdinal,
    );
  }
}
