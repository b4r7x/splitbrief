import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { SessionRef } from '../../../src/core/types/session-ref.js';
import { TASKS_FILE } from '../../../src/core/paths.js';
import { readSpecFile } from '../../../src/core/paths-io.js';
import type {
  BriefRecoveryStateView,
  NormalBriefRecoveryV1,
} from '../../../src/core/schemas/brief-recovery/document.js';
import type { EvidenceRef } from '../../../src/core/schemas/brief-recovery/primitives.js';
import type {
  BriefGenerationRef,
  BriefOwnerCommitInput,
  BriefOwnerCommitPort,
  BriefOwnerEvent,
  TaskExecutionPermit,
} from '../../../src/core/schemas/brief-owner.js';
import {
  type WorkflowStateHead,
  readWorkflowStateHead,
  workflowStateRevision,
} from '../../../src/engine/orchestrator/state-ops.js';
import { drainRecoveryOutbox } from '../../../src/engine/orchestrator/evidence/recovery-journal.js';
import { persistBriefOwnerTransition } from '../../../src/engine/orchestrator/evidence/brief-owner-journal.js';
import { readRecoveryJournal } from '../../../src/core/evidence/recovery-journal/journal.js';
import { publishBriefGeneration } from '../../../src/engine/orchestrator/planning/brief-publication.js';
import {
  type RecoveryRefusalInput,
  automaticRepairIntent,
  refuseRecoveryOperation,
} from '../../../src/engine/orchestrator/planning/brief-recovery.js';
import type { BriefGenerationCandidate } from '../../../src/engine/orchestrator/planning/brief-generation.js';
import type { Planner } from '../../../src/engine/planners/types.js';
import type { ModelCacheAccessor } from '../../../src/engine/providers/model/resolution.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { sha256Hex } from '../../../src/utils/sha256.js';
import { evaluateBriefQuality } from '../../../src/engine/spec/brief-quality.js';
import { parseTasksStrict } from '../../../src/engine/spec/tasks/parse.js';
import {
  makeBriefQualityFailureTask,
  makePassingPlanner,
  makePassingTask,
  REAL_TASKS_MD,
  TEST_METADATA,
} from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  type BindingFixture,
  PRICED_MODEL_CACHE,
  makeRecoveryBinding,
  makeRecoveryBindingFixture,
  normalRecovery,
  recoveryOwnerExpectation,
  stateBytes,
} from '#testing/helpers/brief-recovery-fixtures.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
});

const NOW = '2026-08-13T00:00:00.000Z';

function fixture(
  options: {
    planner?: Planner | undefined;
    modelCache?: ModelCacheAccessor | undefined;
    maxBudget?: number | undefined;
    mode?: WorkflowState['mode'] | undefined;
    model?: string | undefined;
  } = {},
): BindingFixture {
  return makeRecoveryBindingFixture({ dirs, ownerId: 'owner-matrix', ...options });
}

function makeBinding(
  ref: SessionRef,
  options: {
    planner?: Planner | undefined;
    modelCache?: ModelCacheAccessor | undefined;
    maxBudget?: number | undefined;
    model?: string | undefined;
  } = {},
): BindingFixture {
  return makeRecoveryBinding({ ref, ownerId: 'owner-matrix', ...options });
}

function retryCommand(input: {
  sessionId: string;
  epochId: string;
  operationId: string;
  base: EvidenceRef;
  intentHash: string;
  frozenInputIds?: readonly string[] | undefined;
}) {
  return {
    version: 1 as const,
    sessionId: input.sessionId,
    epochId: input.epochId,
    operationId: input.operationId,
    base: input.base,
    intentHash: input.intentHash,
    action: 'retry' as const,
    diagnosticFingerprint: `fingerprint-${input.operationId}`,
    frozenInputIds: input.frozenInputIds ?? ([] as readonly string[]),
  };
}

function ownerExpectedFromHead(head: WorkflowStateHead) {
  return recoveryOwnerExpectation({ head, authorityRevision: workflowStateRevision(head.state) });
}

function lockstepOwnerCommit(ref: SessionRef): BriefOwnerCommitPort {
  return (input) => persistBriefOwnerTransition({ ref, ...input });
}

function refusalOwnerCommit(
  ref: SessionRef,
  head: NonNullable<ReturnType<typeof readWorkflowStateHead>>,
  operationId: string,
): BriefOwnerCommitInput {
  const recovery = normalRecovery(head.state);
  const refusalInput: RecoveryRefusalInput = {
    epochId: recovery.epochId,
    operationId,
    intentHash: sha256Hex(`refusal-${operationId}`),
    action: 'retry',
    code: 'brief_budget_unknown',
    category: 'budget',
    reasonCode: 'brief_budget_unknown',
    reason: 'capped unknown cost',
    accountingKey: null,
    budgetPolicy: 'usd-cap',
    configuredCap: 1,
    priceKnownness: 'provider-dependent',
    spendKnownness: 'unknown-paid',
    evidence: {
      revision: 1,
      hash: sha256Hex(`refusal-evidence-${operationId}`),
      path: `brief-recovery/refusal-${operationId}.json`,
    },
  };
  const mutation = refuseRecoveryOperation(recovery, refusalInput, NOW);
  if (mutation.kind !== 'refused')
    throw new Error(`expected a refusal mutation, got ${mutation.kind}`);
  const nextView: BriefRecoveryStateView = {
    stateVersion: head.state.stateVersion,
    stateRevision: workflowStateRevision(head.state),
    stateFence: head.state.stateFence ?? { token: 0, ownerId: 'initial' },
    phase: head.state.phase,
    briefRecovery: mutation.state,
  };
  const event: BriefOwnerEvent = {
    type: 'brief_recovery_refused',
    ts: 1_752_000_000_000,
    phase: head.state.phase,
    version: 1,
    eventId: `owner-refusal-${operationId}`,
    sessionId: ref.sessionId,
    epochId: recovery.epochId,
    recoveryRevision: recovery.recoveryRevision,
    briefRevision: recovery.activeBrief?.revision ?? 0,
    briefHash: recovery.activeBrief?.hash ?? '0'.repeat(64),
    reportRevision: recovery.matchingReport?.report.revision ?? null,
    reportHash: recovery.matchingReport?.report.hash ?? null,
    intentId: operationId,
    operationId,
    action: 'retry',
    refusalCategory: 'budget',
    refusalCode: 'brief_budget_unknown',
    status: recovery.status,
  };
  return {
    expected: {
      epochId: recovery.epochId,
      stateRevision: head.revision,
      authorityRevision: workflowStateRevision(head.state),
      fence: String(head.state.stateFence?.token ?? 0),
      evidenceHead: recovery.evidenceHead,
    },
    operationId,
    evidence: { epochId: recovery.epochId, kind: 'rejection', payload: event },
    event,
    projectNext: () => ({
      disposition: 'parked',
      authorityRevision: workflowStateRevision(head.state) + 1,
      generation: null,
      permit: null,
      recovery: nextView,
    }),
  };
}

describe('recovery owner integration matrix', () => {
  it('commits at most one concurrent owner acceptance and dispatches exactly once', async () => {
    const review = vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null });
    const planner = makePassingPlanner({ review });
    const a = fixture({ planner, modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    const admission = a.binding.createAdmissionInput({
      state: a.trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: a.ref.projectDir,
      sessionId: a.ref.sessionId,
    });
    const admitted = await a.binding.controller.enterBriefAdmission(admission, a.authority());
    expect(admitted.kind).toBe('blocked');
    const epochId = admitted.epochId ?? 'missing';
    const b = makeBinding(a.ref, { planner, modelCache: PRICED_MODEL_CACHE });
    const command = retryCommand({
      sessionId: a.ref.sessionId,
      epochId,
      operationId: 'owner-race',
      base: admission.activeBrief,
      intentHash: 'owner-race-intent',
    });

    const [first, second] = await Promise.all([
      a.binding.controller.dispatchBriefAction(command, a.authority()),
      b.binding.controller.dispatchBriefAction(command, b.authority()),
    ]);

    expect([first.kind, second.kind].sort()).toEqual(['blocked', 'ready']);
    const loser = first.kind === 'blocked' ? first : second;
    expect(loser).toMatchObject({
      kind: 'blocked',
      code: 'brief_storage_invalid',
      reason: 'Retry acceptance could not be committed.',
    });
    expect(review).toHaveBeenCalledTimes(1);
    const head = readWorkflowStateHead(a.ref);
    if (head === null) throw new Error('expected a committed head');
    const recovery = normalRecovery(head.state);
    expect(Object.keys(recovery.attempts)).toEqual(['owner-race']);
    expect(recovery.attempts['owner-race']).toMatchObject({
      status: 'settled',
      outcome: 'ready',
      reservation: { state: 'held' },
    });
  });

  it('leaves the pre-pointer state byte-identical when the owner commit faults before the state CAS', async () => {
    const review = vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null });
    const f = fixture({ planner: makePassingPlanner({ review }), mode: 'quick' });
    const admission = f.binding.createAdmissionInput({
      state: f.trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: f.ref.projectDir,
      sessionId: f.ref.sessionId,
    });
    const admitted = await f.binding.controller.enterBriefAdmission(admission, f.authority());
    expect(admitted).toMatchObject({ kind: 'blocked' });
    const before = stateBytes(f.ref);

    const committedHead = readWorkflowStateHead(f.ref);
    if (committedHead === null) throw new Error('expected the committed head');
    const faultPoints = ['before-evidence', 'after-evidence', 'before-state-cas'] as const;
    for (const point of faultPoints) {
      const stateBefore = stateBytes(f.ref);
      const input = refusalOwnerCommit(f.ref, committedHead, `fault-${point}`);
      expect(() =>
        persistBriefOwnerTransition({
          ref: f.ref,
          ...input,
          onFault: (fault) => {
            if (fault === point) throw new Error(`fault ${point}`);
          },
        }),
      ).toThrow(`fault ${point}`);
      expect(stateBytes(f.ref)).toBe(stateBefore);
    }
    expect(stateBytes(f.ref)).toBe(before);
    expect(
      readRecoveryJournal(f.ref).records.filter(
        (record) => record.eventId === 'owner-refusal-fault-before-evidence',
      ),
    ).toHaveLength(0);
    expect(
      readRecoveryJournal(f.ref).records.filter(
        (record) => record.eventId === 'owner-refusal-fault-after-evidence',
      ),
    ).toHaveLength(1);
    expect(
      readRecoveryJournal(f.ref).records.filter(
        (record) => record.eventId === 'owner-refusal-fault-before-state-cas',
      ),
    ).toHaveLength(1);
  });

  it('drains a crash-after-commit owner transition exactly once and replays the stale commit as a conflict', async () => {
    const review = vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null });
    const f = fixture({ planner: makePassingPlanner({ review }), mode: 'quick' });
    const admission = f.binding.createAdmissionInput({
      state: f.trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: f.ref.projectDir,
      sessionId: f.ref.sessionId,
    });
    const admitted = await f.binding.controller.enterBriefAdmission(admission, f.authority());
    expect(admitted).toMatchObject({ kind: 'blocked' });
    const head = readWorkflowStateHead(f.ref);
    if (head === null) throw new Error('expected the committed head');
    const input = refusalOwnerCommit(f.ref, head, 'crash-after-commit');
    const before = stateBytes(f.ref);

    expect(() =>
      persistBriefOwnerTransition({
        ref: f.ref,
        ...input,
        onFault: (fault) => {
          if (fault === 'after-state-commit') throw new Error('crash after the state CAS');
        },
      }),
    ).toThrow('crash after the state CAS');
    expect(stateBytes(f.ref)).not.toBe(before);

    let delivered = 0;
    const drained = drainRecoveryOutbox({ ref: f.ref, deliver: () => (delivered += 1) });
    expect(delivered).toBe(1);
    expect(drained.deliveredEventIds).toHaveLength(1);
    const again = drainRecoveryOutbox({ ref: f.ref, deliver: () => (delivered += 1) });
    expect(delivered).toBe(1);
    expect(again.remainingEventIds).toHaveLength(0);
    expect(
      readRecoveryJournal(f.ref).records.filter(
        (record) => record.eventId === 'owner-refusal-crash-after-commit',
      ),
    ).toHaveLength(1);

    const afterDrain = stateBytes(f.ref);
    const replay = persistBriefOwnerTransition({ ref: f.ref, ...input });
    expect(replay.kind).toBe('conflict');
    expect(stateBytes(f.ref)).toBe(afterDrain);
  });

  it('replays a settled attempt after owner restart without advancing the persisted authority', async () => {
    const review = vi.fn().mockResolvedValue({
      text: '---\nid: T001\n---\n### Description\nmalformed task block\n',
      usage: null,
    });
    const planner = makePassingPlanner({ review });
    const f = fixture({ planner, modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    const admission = f.binding.createAdmissionInput({
      state: f.trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: f.ref.projectDir,
      sessionId: f.ref.sessionId,
    });
    const admitted = await f.binding.controller.enterBriefAdmission(admission, f.authority());
    const epochId = admitted.epochId ?? 'missing';
    const command = retryCommand({
      sessionId: f.ref.sessionId,
      epochId,
      operationId: 'restart-replay',
      base: admission.activeBrief,
      intentHash: 'restart-replay-intent',
    });
    const first = await f.binding.controller.dispatchBriefAction(command, f.authority());
    expect(first).toMatchObject({ kind: 'blocked', code: 'brief_quality_unavailable' });

    const before = stateBytes(f.ref);
    const restarted = makeBinding(f.ref, { planner, modelCache: PRICED_MODEL_CACHE });
    const replay = await restarted.binding.controller.dispatchBriefAction(
      command,
      restarted.authority(),
    );

    expect(replay).toMatchObject({ kind: 'replayed' });
    if (replay.kind !== 'replayed') return;
    expect(replay.receipt).toMatchObject({
      status: 'settled',
      outcome: 'quality-failed',
      reservation: { state: 'held' },
    });
    expect(review).toHaveBeenCalledTimes(1);
    expect(stateBytes(f.ref)).toBe(before);
  });

  it('parks an ambiguous dispatch unresolved with a held reservation and converges after resolution', async () => {
    const review = vi
      .fn()
      .mockImplementationOnce(async (_prompt, _projectDir, callbacks) => {
        callbacks.onCallEvent?.({
          type: 'call_started',
          ts: 1,
          callId: 'call-ambig-1',
          role: 'planner',
          backendKind: 'cli',
        });
        throw new Error('connection lost');
      })
      .mockResolvedValue({ text: REAL_TASKS_MD, usage: null });
    const planner = makePassingPlanner({ review });
    const f = fixture({ planner, modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    const admission = f.binding.createAdmissionInput({
      state: f.trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: f.ref.projectDir,
      sessionId: f.ref.sessionId,
    });
    const admitted = await f.binding.controller.enterBriefAdmission(admission, f.authority());
    const epochId = admitted.epochId ?? 'missing';
    const queued = await f.binding.controller.queueBriefInput(
      {
        sessionId: f.ref.sessionId,
        epochId,
        inputId: 'held-input',
        sequence: 1,
        kind: 'feedback',
        source: 'interactive',
        payload: 'keep this feedback',
        base: admission.activeBrief,
        operationId: null,
      },
      f.authority(),
    );
    expect(queued.kind).toBe('accepted');
    const unresolved = await f.binding.controller.dispatchBriefAction(
      retryCommand({
        sessionId: f.ref.sessionId,
        epochId,
        operationId: 'certainty-1',
        base: admission.activeBrief,
        intentHash: 'certainty-1-intent',
        frozenInputIds: ['held-input'],
      }),
      f.authority(),
    );
    expect(unresolved).toMatchObject({
      kind: 'unresolved',
      projection: { status: 'unresolved', remoteUsage: 'REMOTE USAGE UNKNOWN' },
    });
    const persisted = normalRecovery(readWorkflowStateHead(f.ref)?.state ?? f.trackedState());
    expect(persisted.attempts['certainty-1']).toMatchObject({
      status: 'unresolved',
      dispatchPossibility: 'possible',
      remoteObservation: 'unknown',
      reservation: { state: 'held', usageApplied: false },
    });

    const resolved = await f.binding.controller.dispatchBriefAction(
      {
        version: 1,
        sessionId: f.ref.sessionId,
        epochId,
        operationId: 'certainty-1',
        base: admission.activeBrief,
        intentHash: 'certainty-1-intent',
        action: 'resolve-unresolved',
        heldInputIds: ['held-input'],
        resolution: { kind: 'rebind', acknowledgeRemoteDuplicationRisk: true },
      },
      f.authority(),
    );
    expect(resolved).toMatchObject({ kind: 'blocked', code: 'brief_contract_blocked' });

    const retried = await f.binding.controller.dispatchBriefAction(
      retryCommand({
        sessionId: f.ref.sessionId,
        epochId,
        operationId: 'certainty-2',
        base: admission.activeBrief,
        intentHash: 'certainty-2-intent',
        frozenInputIds: ['held-input'],
      }),
      f.authority(),
    );
    expect(retried).toMatchObject({ kind: 'ready', projection: { status: 'ready' } });
    expect(review).toHaveBeenCalledTimes(2);
    const finalRecovery = normalRecovery(readWorkflowStateHead(f.ref)?.state ?? f.trackedState());
    expect(finalRecovery.attempts['certainty-1']).toMatchObject({
      status: 'unresolved',
      reservation: { state: 'held' },
    });
    expect(finalRecovery.attempts['certainty-2']).toMatchObject({
      status: 'settled',
      outcome: 'ready',
    });
  });

  it('books one reconciled reservation once and never double-settles the same operation', async () => {
    const review = vi
      .fn()
      .mockResolvedValue({ text: REAL_TASKS_MD, usage: { inputTokens: 100, outputTokens: 50 } });
    const planner = makePassingPlanner({ review });
    const f = fixture({ planner, modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    const admission = f.binding.createAdmissionInput({
      state: f.trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: f.ref.projectDir,
      sessionId: f.ref.sessionId,
    });
    const admitted = await f.binding.controller.enterBriefAdmission(admission, f.authority());
    const epochId = admitted.epochId ?? 'missing';
    const result = await f.binding.controller.dispatchBriefAction(
      retryCommand({
        sessionId: f.ref.sessionId,
        epochId,
        operationId: 'reservation-1',
        base: admission.activeBrief,
        intentHash: 'reservation-1-intent',
      }),
      f.authority(),
    );
    expect(result).toMatchObject({ kind: 'ready' });
    let recovery = normalRecovery(readWorkflowStateHead(f.ref)?.state ?? f.trackedState());
    const receipt = recovery.attempts['reservation-1'];
    if (receipt === undefined) throw new Error('expected a settled reservation receipt');
    expect(receipt).toMatchObject({
      status: 'settled',
      outcome: 'ready',
      reservation: {
        state: 'reconciled',
        usageApplied: true,
        accountingKey: {
          sessionId: f.ref.sessionId,
          epochId,
          operationId: 'reservation-1',
          generation: 0,
        },
      },
    });
    if (receipt.status !== 'settled') return;
    expect(receipt.reservation.pricing).toMatchObject({
      budgetUnit: 'usd',
      pricingIdentity: 'custom-endpoint/gpt-5.4',
    });
    expect(recovery.committedSpend).toBeGreaterThan(0);
    const bookedOnce = recovery.committedSpend;

    const resettled = await f.binding.controller.settlePlannerAttempt(
      {
        sessionId: f.ref.sessionId,
        epochId,
        operationId: 'reservation-1',
        requestId: 'missing-request',
        dispatchPossibility: 'possible',
        remoteObservation: 'confirmed-final',
        outcome: 'ready',
        candidate: receipt.candidate,
        report: receipt.report,
        providerCode: null,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, estimated: false },
        settledAt: NOW,
      },
      f.authority(),
    );
    expect(resettled).toMatchObject({ kind: 'conflict' });
    recovery = normalRecovery(readWorkflowStateHead(f.ref)?.state ?? f.trackedState());
    expect(recovery.committedSpend).toBe(bookedOnce);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it('persists a capped unknown-cost refusal through the binding and replays it after restart without a second write', async () => {
    const review = vi.fn().mockResolvedValue({ text: REAL_TASKS_MD, usage: null });
    const planner = makePassingPlanner({ review });
    const f = fixture({
      planner,
      maxBudget: 1,
      mode: 'standard',
      model: 'not-in-catalog-model',
    });
    const admission = f.binding.createAdmissionInput({
      state: f.trackedState(),
      tasks: [makeBriefQualityFailureTask()],
      projectDir: f.ref.projectDir,
      sessionId: f.ref.sessionId,
    });
    const refused = await f.binding.controller.enterBriefAdmission(admission, f.authority());

    expect(refused).toMatchObject({
      kind: 'blocked',
      code: 'brief_budget_unknown',
      projection: { budget: { state: 'refused', refusalCode: 'brief_budget_unknown' } },
    });
    expect(refused.operationId).not.toBeNull();
    expect(review).not.toHaveBeenCalled();
    const head = readWorkflowStateHead(f.ref);
    if (head === null) throw new Error('expected a committed head');
    const recovery = normalRecovery(head.state);
    expect(recovery.automaticRepair).toMatchObject({ eligible: true, consumed: false });
    const refusal = recovery.refusalRetention?.refusals[refused.operationId ?? ''];
    expect(refusal).toMatchObject({
      code: 'brief_budget_unknown',
      category: 'budget',
      budgetPolicy: 'usd-cap',
      configuredCap: 1,
      priceKnownness: 'provider-dependent',
      spendKnownness: 'unknown-paid',
      automaticAllowance: { eligible: true, consumed: false },
    });

    const before = stateBytes(f.ref);
    const restarted = makeBinding(f.ref, {
      planner,
      maxBudget: 1,
      model: 'not-in-catalog-model',
    });
    const replay = await restarted.binding.controller.dispatchBriefAction(
      retryCommand({
        sessionId: f.ref.sessionId,
        epochId: recovery.epochId,
        operationId: refused.operationId ?? 'missing',
        base: recovery.activeBrief,
        intentHash: automaticRepairIntent(recovery),
      }),
      restarted.authority(),
    );
    expect(replay).toMatchObject({
      kind: 'blocked',
      code: 'brief_budget_unknown',
      projection: { budget: { state: 'refused', refusalCode: 'brief_budget_unknown' } },
    });
    expect(review).not.toHaveBeenCalled();
    expect(stateBytes(f.ref)).toBe(before);
  });

  it('publishes an immutable generation through the owner port and loses a stale publish byte-identically', async () => {
    const f = fixture({ modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    const admission = f.binding.createAdmissionInput({
      state: f.trackedState(),
      tasks: [makePassingTask()],
      projectDir: f.ref.projectDir,
      sessionId: f.ref.sessionId,
    });
    const admitted = await f.binding.controller.enterBriefAdmission(admission, f.authority());
    expect(admitted).toMatchObject({ kind: 'ready', projection: { status: 'ready' } });
    const head = readWorkflowStateHead(f.ref);
    if (head === null) throw new Error('expected a committed head');
    const recovery = normalRecovery(head.state);
    const tasks = parseTasksStrict(REAL_TASKS_MD);
    const candidate: BriefGenerationCandidate = {
      programId: null,
      parentGenerationId: null,
      batchReceiptDigests: [],
      tasksText: REAL_TASKS_MD,
      qualityReport: evaluateBriefQuality(tasks),
      support: [
        { name: 'research.md', text: '# Research\n' },
        { name: 'plan.md', text: '# Plan\n' },
      ],
    };
    const expected = ownerExpectedFromHead(head);
    const published = publishBriefGeneration({
      ref: f.ref,
      candidate,
      expected,
      operationId: 'owner-matrix-publish',
      eventId: 'owner-matrix-publish-1',
      recoveryRevision: recovery.recoveryRevision,
      phase: head.state.phase,
      ts: 1_752_000_000_000,
      commit: lockstepOwnerCommit(f.ref),
      bus: createEventBus(),
      metadata: TEST_METADATA,
    });

    expect(published.ok).toBe(true);
    if (!published.ok) return;
    if (published.committed.generation === null) throw new Error('expected a committed generation');
    const generation: BriefGenerationRef = published.committed.generation;
    expect(published.committed.permit).toBeNull();
    const committedHead = readWorkflowStateHead(f.ref);
    if (committedHead === null) throw new Error('expected the generation head');
    expect(committedHead.state.generation).toEqual(generation);
    expect(committedHead.state.permit).toBeNull();
    const projected = readSpecFile(f.ref, TASKS_FILE);
    expect(projected).not.toBeNull();
    if (projected === null) return;
    expect(parseTasksStrict(projected)).toEqual(parseTasksStrict(REAL_TASKS_MD));

    const beforeStale = stateBytes(f.ref);
    const stale = publishBriefGeneration({
      ref: f.ref,
      candidate,
      expected,
      operationId: 'owner-matrix-publish-stale',
      eventId: 'owner-matrix-publish-stale',
      recoveryRevision: recovery.recoveryRevision,
      phase: head.state.phase,
      ts: 1_752_000_000_001,
      commit: lockstepOwnerCommit(f.ref),
      bus: createEventBus(),
      metadata: TEST_METADATA,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.fault).toBe('cas');
    expect(stateBytes(f.ref)).toBe(beforeStale);
  });

  it('issues a matching execution permit through the owner port and fails closed on a mismatched generation', async () => {
    const f = fixture({ modelCache: PRICED_MODEL_CACHE, mode: 'quick' });
    const admission = f.binding.createAdmissionInput({
      state: f.trackedState(),
      tasks: [makePassingTask()],
      projectDir: f.ref.projectDir,
      sessionId: f.ref.sessionId,
    });
    const admitted = await f.binding.controller.enterBriefAdmission(admission, f.authority());
    expect(admitted).toMatchObject({ kind: 'ready' });
    const head = readWorkflowStateHead(f.ref);
    if (head === null) throw new Error('expected a committed head');
    const recovery = normalRecovery(head.state);
    const tasks = parseTasksStrict(REAL_TASKS_MD);
    const candidate: BriefGenerationCandidate = {
      programId: null,
      parentGenerationId: null,
      batchReceiptDigests: [],
      tasksText: REAL_TASKS_MD,
      qualityReport: evaluateBriefQuality(tasks),
      support: [
        { name: 'research.md', text: '# Research\n' },
        { name: 'plan.md', text: '# Plan\n' },
      ],
    };
    const published = publishBriefGeneration({
      ref: f.ref,
      candidate,
      expected: ownerExpectedFromHead(head),
      operationId: 'owner-matrix-publish',
      eventId: 'owner-matrix-publish-1',
      recoveryRevision: recovery.recoveryRevision,
      phase: head.state.phase,
      ts: 1_752_000_000_000,
      commit: lockstepOwnerCommit(f.ref),
      bus: createEventBus(),
      metadata: TEST_METADATA,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    if (published.committed.generation === null) throw new Error('expected a committed generation');
    const generation: BriefGenerationRef = published.committed.generation;
    const generationHead = readWorkflowStateHead(f.ref);
    if (generationHead === null) throw new Error('expected the generation head');
    const expected = ownerExpectedFromHead(generationHead);
    const permit: TaskExecutionPermit = {
      version: 1,
      epochId: expected.epochId,
      authorityRevision: expected.authorityRevision + 1,
      generationId: generation.generationId,
      manifestDigest: generation.manifestDigest,
      tasksDigest: generation.tasksDigest,
      qualityDigest: generation.qualityDigest,
      approvalEvidence: {
        revision: 1,
        hash: sha256Hex('approval'),
        path: 'brief-recovery/approval.json',
      },
      issuedAt: NOW,
    };
    const event: BriefOwnerEvent = {
      type: 'brief_execution_permit_issued',
      ts: 1_752_000_000_000,
      phase: generationHead.state.phase,
      version: 1,
      eventId: 'owner-matrix-permit-1',
      sessionId: f.ref.sessionId,
      epochId: expected.epochId,
      recoveryRevision: recovery.recoveryRevision,
      operationId: 'owner-matrix-permit',
      generation,
      permit,
    };
    const committed = lockstepOwnerCommit(f.ref)({
      expected,
      operationId: 'owner-matrix-permit',
      evidence: { epochId: expected.epochId, kind: 'outcome', payload: event },
      event,
      projectNext: ({ current }) => {
        const ready = current.briefRecovery;
        if (ready === null || ready === undefined || ready.status !== 'ready')
          throw new Error('expected a ready recovery');
        return {
          disposition: 'ready-for-tasks',
          authorityRevision: expected.authorityRevision + 1,
          generation,
          permit,
          recovery: {
            ...current,
            briefRecovery: ready as NormalBriefRecoveryV1 & { status: 'ready' },
          },
        };
      },
    });
    expect(committed.kind).toBe('committed');
    if (committed.kind !== 'committed') return;
    expect(committed.permit).toEqual(permit);
    expect(committed.generation).toEqual(generation);
    const permitHead = readWorkflowStateHead(f.ref);
    if (permitHead === null) throw new Error('expected the permit head');
    expect(permitHead.state.permit).toEqual(permit);
    expect(permitHead.state.generation).toEqual(generation);

    const beforeMismatch = stateBytes(f.ref);
    const mismatchedEvent: BriefOwnerEvent = {
      ...event,
      eventId: 'owner-matrix-permit-mismatch',
      generation: { ...generation, generationId: 'brief-wrong-generation' },
    };
    const freshExpected = ownerExpectedFromHead(permitHead);
    expect(() =>
      lockstepOwnerCommit(f.ref)({
        expected: freshExpected,
        operationId: 'owner-matrix-permit-mismatch',
        evidence: { epochId: freshExpected.epochId, kind: 'outcome', payload: mismatchedEvent },
        event: mismatchedEvent,
        projectNext: ({ current }) => {
          const ready = current.briefRecovery;
          if (ready === null || ready === undefined || ready.status !== 'ready')
            throw new Error('expected a ready recovery');
          return {
            disposition: 'ready-for-tasks',
            authorityRevision: freshExpected.authorityRevision + 1,
            generation,
            permit: { ...permit, authorityRevision: freshExpected.authorityRevision + 1 },
            recovery: {
              ...current,
              briefRecovery: ready as NormalBriefRecoveryV1 & { status: 'ready' },
            },
          };
        },
      }),
    ).toThrow(/the owner patch must identify the generation and permit the event carries/u);
    expect(stateBytes(f.ref)).toBe(beforeMismatch);
  });
});
