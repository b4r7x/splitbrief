import { describe, expect, it } from 'vitest';
import {
  createTaskCompilationAttemptId,
  createTaskCompilationBatchId,
  createTaskCompilationProgramId,
  TaskCompilationOperationIdSchema,
  TaskCompilationProgramSchema,
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationOperationId,
} from '../../core/schemas/task-compilation.js';
import {
  createTaskDispatchClaimPort,
  createTaskDispatchLedger,
  DispatchLedgerSnapshotSchema,
  type DispatchLedgerSnapshot,
} from './dispatch-ledger.js';

const programId = createTaskCompilationProgramId({ feature: 'dispatch-ledger-fixture' });
const batches = Array.from({ length: TASK_BRIEF_COMPILER_POLICY.maxDispatches }, (_, ordinal) => {
  const prompt = `batch-${ordinal}`;
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  return {
    batchId: createTaskCompilationBatchId(programId, ordinal, [ordinal]),
    manifestOrdinals: [ordinal],
    prompt,
    envelope: {
      version: 1,
      promptBytes,
      inputTokensUpperBound: promptBytes,
      requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
      outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
      maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
      maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
      maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
      maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
      deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
      idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    },
  };
});
const totalPromptBytes = batches.reduce((total, batch) => total + batch.envelope.promptBytes, 0);
const program = TaskCompilationProgramSchema.parse({
  policyVersion: TASK_BRIEF_COMPILER_POLICY.version,
  programId,
  manifestDigest: 'manifest-digest',
  inputDigests: {
    spec: 'spec-digest',
    plan: 'plan-digest',
    languageContext: 'language-context-digest',
    repairSubject: null,
  },
  batches,
  operationEnvelope: {
    version: 1,
    dispatchLimit: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
    callCount: batches.length,
    totalPromptBytes,
    totalInputTokensUpperBound: totalPromptBytes,
    totalOutputTokensUpperBound:
      TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes * batches.length,
    totalNormalizedOutputBytes:
      TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes * batches.length,
    totalDeclaredArtifactBytes:
      TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes * batches.length,
    callsDigest: 'calls-digest',
  },
});
const operation = program.operationEnvelope;

function createOperationId(label: string): TaskCompilationOperationId {
  return TaskCompilationOperationIdSchema.parse(`operation-${label}`);
}

function createLedger(
  operationId: TaskCompilationOperationId,
  claimPort = createTaskDispatchClaimPort(),
  restore?: DispatchLedgerSnapshot,
) {
  return createTaskDispatchLedger({
    operation,
    operationId,
    claimPort,
    ...(restore === undefined ? {} : { restore }),
  });
}

function createSnapshot(
  operationId: TaskCompilationOperationId,
  claimedAttemptIds: readonly string[],
): DispatchLedgerSnapshot {
  return DispatchLedgerSnapshotSchema.parse({
    operationId,
    dispatchCount: claimedAttemptIds.length,
    dispatchLimit: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
    claimedAttemptIds,
  });
}

describe('task dispatch ledger', () => {
  it('starts fresh and records the claim on the snapshot', () => {
    const ledger = createLedger(createOperationId('callback'));
    let observedCount = 0;

    expect(ledger.snapshot()).toMatchObject({
      dispatchCount: 0,
      dispatchLimit: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
      claimedAttemptIds: [],
    });
    const claim = ledger.claimDispatch(createTaskCompilationAttemptId());
    if (claim.kind === 'claimed') observedCount = ledger.snapshot().dispatchCount;

    expect(claim.kind).toBe('claimed');
    expect(observedCount).toBe(1);
  });

  it('allows claims 1 through 64 and refuses claim 65', () => {
    const ledger = createLedger(createOperationId('capacity'));
    let invoked = 0;

    for (let index = 0; index < TASK_BRIEF_COMPILER_POLICY.maxDispatches; index += 1) {
      const claim = ledger.claimDispatch(createTaskCompilationAttemptId());
      if (claim.kind === 'claimed') invoked += 1;
      expect(claim.kind).toBe('claimed');
    }

    const refused = ledger.claimDispatch(createTaskCompilationAttemptId());
    if (refused.kind === 'claimed') invoked += 1;
    expect(refused).toEqual({
      kind: 'refused',
      attemptId: expect.any(String),
      reason: 'dispatch-limit',
      dispatchCount: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
      dispatchLimit: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
    });
    expect(invoked).toBe(TASK_BRIEF_COMPILER_POLICY.maxDispatches);
    expect(ledger.snapshot().dispatchCount).toBe(TASK_BRIEF_COMPILER_POLICY.maxDispatches);
  });

  it('charges an attempt once and keeps the charge across retry-shaped calls', () => {
    const ledger = createLedger(createOperationId('retry'));
    const attemptId = createTaskCompilationAttemptId();

    expect(ledger.claimDispatch(attemptId).kind).toBe('claimed');
    expect(ledger.claimDispatch(attemptId)).toEqual({
      kind: 'refused',
      attemptId,
      reason: 'attempt-already-claimed',
      dispatchCount: 1,
      dispatchLimit: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
    });
    expect(ledger.snapshot().dispatchCount).toBe(1);
  });

  it('reconstructs from explicit durable state without changing the frozen envelope', () => {
    const operationId = createOperationId('reconstructed');
    const first = createLedger(operationId);

    for (let index = 0; index < 63; index += 1) {
      expect(first.claimDispatch(createTaskCompilationAttemptId()).kind).toBe('claimed');
    }

    const durableState = first.snapshot();
    const reconstructed = createLedger(operationId, createTaskDispatchClaimPort(), durableState);
    expect(durableState.dispatchCount).toBe(63);
    expect(reconstructed.snapshot()).toEqual(durableState);

    const firstAttemptId = durableState.claimedAttemptIds[0];
    if (firstAttemptId === undefined) throw new Error('durable state has no claimed attempts');
    let invoked = 0;
    const next = reconstructed.claimDispatch(createTaskCompilationAttemptId());
    if (next.kind === 'claimed') invoked += 1;

    expect(reconstructed.claimDispatch(firstAttemptId)).toMatchObject({
      kind: 'refused',
      reason: 'attempt-already-claimed',
      dispatchCount: 64,
    });
    expect(next).toMatchObject({ kind: 'claimed', dispatchNumber: 64, remaining: 0 });
    const overLimit = reconstructed.claimDispatch(createTaskCompilationAttemptId());
    if (overLimit.kind === 'claimed') invoked += 1;
    expect(overLimit).toMatchObject({
      kind: 'refused',
      reason: 'dispatch-limit',
      dispatchCount: 64,
    });
    expect(invoked).toBe(1);
    expect(operation.callCount).toBe(TASK_BRIEF_COMPILER_POLICY.maxDispatches);
    expect(Object.isFrozen(operation)).toBe(true);
  });

  it('shares attempts for one operation but isolates concurrent same-digest operations', () => {
    const claimPort = createTaskDispatchClaimPort();
    const first = createLedger(createOperationId('same-digest-first'), claimPort);
    const second = createLedger(createOperationId('same-digest-second'), claimPort);
    const attemptId = createTaskCompilationAttemptId();

    expect(first.claimDispatch(attemptId).kind).toBe('claimed');
    expect(second.claimDispatch(attemptId).kind).toBe('claimed');
    expect(first.snapshot()).toMatchObject({ dispatchCount: 1, claimedAttemptIds: [attemptId] });
    expect(second.snapshot()).toMatchObject({ dispatchCount: 1, claimedAttemptIds: [attemptId] });
    expect(first.snapshot().operationId).not.toBe(second.snapshot().operationId);
  });

  it('shares attempt claims across handles with the same operation identity', () => {
    const claimPort = createTaskDispatchClaimPort();
    const operationId = createOperationId('shared');
    const first = createLedger(operationId, claimPort);
    const second = createLedger(operationId, claimPort);
    const attemptId = createTaskCompilationAttemptId();

    expect(first.claimDispatch(attemptId).kind).toBe('claimed');
    expect(second.claimDispatch(attemptId)).toEqual({
      kind: 'refused',
      attemptId,
      reason: 'attempt-already-claimed',
      dispatchCount: 1,
      dispatchLimit: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
    });
  });

  it('reconciles disjoint concurrent-owner restores by union cardinality', () => {
    const claimPort = createTaskDispatchClaimPort();
    const operationId = createOperationId('concurrent-restore');
    const firstAttemptId = createTaskCompilationAttemptId();
    const secondAttemptId = createTaskCompilationAttemptId();
    const first = createLedger(
      operationId,
      claimPort,
      createSnapshot(operationId, [firstAttemptId]),
    );

    const second = createLedger(
      operationId,
      claimPort,
      createSnapshot(operationId, [secondAttemptId]),
    );

    const mergedSnapshot = second.snapshot();
    expect(mergedSnapshot).toMatchObject({
      dispatchCount: 2,
      claimedAttemptIds: [firstAttemptId, secondAttemptId],
    });
    expect(DispatchLedgerSnapshotSchema.parse(mergedSnapshot)).toEqual(mergedSnapshot);
    expect(first.snapshot()).toEqual(mergedSnapshot);
  });

  it('rejects divergent restores whose attempt union exceeds the hard limit', () => {
    const operationId = createOperationId('divergent-restore');
    const attemptIds = Array.from({ length: TASK_BRIEF_COMPILER_POLICY.maxDispatches + 1 }, () =>
      createTaskCompilationAttemptId(),
    );
    const claimPort = createTaskDispatchClaimPort();
    const firstRestore = createSnapshot(
      operationId,
      attemptIds.slice(0, TASK_BRIEF_COMPILER_POLICY.maxDispatches),
    );
    const secondRestore = createSnapshot(
      operationId,
      attemptIds.slice(1, TASK_BRIEF_COMPILER_POLICY.maxDispatches + 1),
    );
    const first = createLedger(operationId, claimPort, firstRestore);

    expect(() => createLedger(operationId, claimPort, secondRestore)).toThrow(
      'dispatch ledger restore exceeds dispatch limit',
    );
    expect(first.snapshot()).toEqual(firstRestore);
    expect(DispatchLedgerSnapshotSchema.parse(first.snapshot())).toEqual(firstRestore);
  });

  it('rejects invalid snapshots and validates emitted snapshots', () => {
    const operationId = createOperationId('snapshot-validation');
    const invalidSnapshot: DispatchLedgerSnapshot = {
      operationId,
      dispatchCount: 1,
      dispatchLimit: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
      claimedAttemptIds: [],
    };

    expect(() =>
      createLedger(operationId, createTaskDispatchClaimPort(), invalidSnapshot),
    ).toThrow();

    const snapshot = createLedger(operationId).snapshot();
    expect(DispatchLedgerSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('keeps independent host-owned ports isolated', () => {
    const operationId = createOperationId('ports');
    const exhausted = createLedger(operationId);
    for (let index = 0; index < TASK_BRIEF_COMPILER_POLICY.maxDispatches; index += 1) {
      expect(exhausted.claimDispatch(createTaskCompilationAttemptId()).kind).toBe('claimed');
    }

    const fresh = createLedger(operationId);
    expect(fresh.claimDispatch(createTaskCompilationAttemptId()).kind).toBe('claimed');
  });

  it('rejects durable state for a different operation identity', () => {
    const durableState = createLedger(createOperationId('restore-source')).snapshot();

    expect(() =>
      createLedger(createOperationId('restore-other'), createTaskDispatchClaimPort(), durableState),
    ).toThrow('dispatch ledger restore operation identity changed');
  });
});
