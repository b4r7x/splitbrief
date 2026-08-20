import { describe, expect, it } from 'vitest';
import type {
  BriefAdmissionInput,
  BriefRecoveryControllerDeps,
  BriefRecoveryStateView,
  BudgetReservation,
  EvidenceRef,
  RecoveryProviderRequest,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import { BriefRecoveryStateViewSchema } from '../../../core/schemas/brief-recovery.js';
import type {
  BriefOwnerCommitInput,
  BriefOwnerCommitPort,
  BriefOwnerCommitResult,
} from '../../../core/schemas/brief-owner.js';
import { createBriefRecoveryController } from './brief-recovery-controller.js';

const ref = (hash: string, path: string): EvidenceRef => ({ revision: 1, hash, path });

type MutableDependencies = {
  -readonly [Key in keyof BriefRecoveryControllerDeps]: BriefRecoveryControllerDeps[Key];
};

function authority(revision = 0): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId: 'session-1',
    ownerId: 'owner-1',
    pid: 1,
    processStart: 'start-1',
    runId: 'run-1',
    acquisitionId: 'acquisition-1',
    fence: 1,
    stateRevision: revision,
    stateDigest: 'digest-1',
  };
}

function budgetReservation(input: {
  sessionId: string;
  epochId: string;
  operationId: string;
}): BudgetReservation {
  return {
    accountingKey: { ...input, generation: 0 },
    amount: 0.1,
    state: 'reserved',
    usageApplied: false,
    appliedUsage: null,
    history: [{ state: 'reserved', at: '2026-01-01T00:00:00.000Z', reason: 'accepted' }],
  };
}

function makeDependencies(calls: { provider: number }): MutableDependencies {
  return {
    provider: {
      async dispatch(input: RecoveryProviderRequest) {
        calls.provider += 1;
        return {
          kind: 'completed',
          requestId: input.requestId,
          dispatchPossibility: 'possible',
          remoteObservation: 'confirmed-final',
          text: 'a corrected brief',
          providerCode: null,
          usage: null,
        };
      },
    },
    budget: {
      estimate: () => ({
        kind: 'finite',
        budgetUnit: 'usd',
        inputTokens: 1,
        outputTokens: 1,
        amount: 0.1,
        pricingIdentity: 'test',
      }),
      reserve: ({ accountingKey }) => ({
        kind: 'reserved',
        reservation: budgetReservation(accountingKey),
      }),
      reconcile: ({ reservation }) => ({ reservation, usageApplied: false, appliedAmount: 0 }),
      terminalCharge: ({ reservation }) => ({ reservation, usageApplied: false, appliedAmount: 0 }),
    },
    evaluateQuality: () => [],
    readRetryContext: () => ({
      prompt: 'repair the original Task Briefs',
      projectDir: '/tmp/original-project',
      currentKnownSpend: 0,
      maxBudget: 1,
    }),
    commit: makeRecordingOwner().port,
  };
}

function admission(overrides: Partial<BriefAdmissionInput> = {}): BriefAdmissionInput {
  const brief = ref('brief-hash', 'tasks.md');
  return {
    sessionId: 'session-1',
    origin: { mode: 'quick', entry: 'initial' },
    continuation: { version: 1, kind: 'quick-start', entry: 'initial' },
    activeBrief: brief,
    report: {
      briefHash: brief.hash,
      report: ref('report-hash', 'brief-quality.json'),
      ruleVersion: 'brief-quality-v1',
      issues: [
        {
          code: 'missing_scope',
          severity: 'error',
          taskId: 'T001',
          message: 'scope is missing',
        },
      ],
      errorCount: 1,
    },
    qualityPolicyVersion: 'brief-quality-v1',
    ...overrides,
  };
}

function standardAdmission(): BriefAdmissionInput {
  return {
    ...admission(),
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
  };
}

function retryCommand(input: {
  epochId: string;
  operationId: string;
  intentHash?: string | undefined;
  base?: EvidenceRef | undefined;
  frozenInputIds?: readonly string[] | undefined;
}) {
  return {
    version: 1 as const,
    sessionId: 'session-1',
    epochId: input.epochId,
    operationId: input.operationId,
    base: input.base ?? admission().activeBrief,
    intentHash: input.intentHash ?? `${input.operationId}-intent`,
    action: 'retry' as const,
    diagnosticFingerprint: `${input.operationId}-diagnostic`,
    frozenInputIds: input.frozenInputIds ?? ([] as readonly string[]),
  };
}

function conflictResult(): BriefOwnerCommitResult {
  return {
    kind: 'conflict',
    stateRevision: null,
    authorityRevision: null,
    recovery: null,
    generation: null,
    permit: null,
  };
}

type OwnerRecord = Readonly<{
  input: BriefOwnerCommitInput;
  result: BriefOwnerCommitResult;
  current: BriefRecoveryStateView;
}>;

function makeRecordingOwner(
  options: {
    conflictOnCommit?: number | undefined;
    throwOnCommit?: number | undefined;
    uncertainOnCommit?: number | undefined;
  } = {},
): { port: BriefOwnerCommitPort; calls: OwnerRecord[]; view: () => BriefRecoveryStateView } {
  const calls: OwnerRecord[] = [];
  let view: BriefRecoveryStateView = {
    stateVersion: 4,
    stateRevision: 0,
    stateFence: { token: 1, ownerId: 'owner-1' },
    phase: 'reviewing-briefs',
    briefRecovery: null,
  };
  const port: BriefOwnerCommitPort = (input) => {
    const ordinal = calls.length + 1;
    if (options.throwOnCommit === ordinal) throw new Error('owner commit failed');
    if (options.conflictOnCommit === ordinal) {
      calls.push({ input, result: conflictResult(), current: view });
      return conflictResult();
    }
    const evidenceRef = {
      revision: 1 as const,
      hash: '0'.repeat(64),
      path: `brief-recovery/owner-${ordinal}.json`,
    };
    const patch = input.projectNext({
      current: view,
      evidenceRef,
      eventId: input.event.eventId,
    });
    const result: BriefOwnerCommitResult = {
      kind: options.uncertainOnCommit === ordinal ? 'durability-uncertain' : 'committed',
      stateRevision: {
        rawSha256: input.expected.stateRevision.rawSha256,
        fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
      },
      authorityRevision: patch.authorityRevision,
      recovery: patch.recovery,
      generation: patch.generation,
      permit: patch.permit,
    };
    calls.push({ input, result, current: view });
    view = patch.recovery;
    return result;
  };
  return { port, calls, view: () => view };
}

function normalPersisted(view: BriefRecoveryStateView) {
  const recovery = view.briefRecovery;
  if (recovery === null || recovery === undefined || !('attempts' in recovery))
    throw new Error('expected a normal persisted recovery');
  return recovery;
}

describe('createBriefRecoveryController — sole owner commit seam', () => {
  it('commits admission with the exact expected tuple and advances the local head', async () => {
    const calls = { provider: 0 };
    const owner = makeRecordingOwner();
    const deps = makeDependencies(calls);
    deps.commit = owner.port;
    const controller = createBriefRecoveryController(deps);

    const admitted = await controller.enterBriefAdmission(admission(), authority());

    expect(admitted).toMatchObject({ kind: 'blocked', projection: { stateRevision: 1 } });
    expect(owner.calls).toHaveLength(1);
    const record = owner.calls[0];
    if (record === undefined) return;
    expect(record.input.expected).toEqual({
      epochId: admitted.epochId,
      stateRevision: {
        rawSha256: 'digest-1',
        fileIdentity: { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n },
      },
      authorityRevision: 0,
      fence: '1',
      evidenceHead: null,
    });
    expect(record.input.evidence).toMatchObject({ epochId: admitted.epochId, kind: 'outcome' });
    expect(record.input.evidence.payload).toMatchObject({ kind: 'brief-admission' });
    expect(record.result).toMatchObject({ kind: 'committed', authorityRevision: 1 });
    expect(record.input.event.type).toBe('brief_recovery_transition');

    const second = await controller.enterBriefAdmission(admission(), authority(1));
    expect(second).toMatchObject({ kind: 'blocked', projection: { stateRevision: 1 } });
    expect(owner.calls).toHaveLength(1);
  });

  it('commits retry acceptance and the dispatch fence as two advancing owner commits', async () => {
    const calls = { provider: 0 };
    const owner = makeRecordingOwner();
    const deps = makeDependencies(calls);
    deps.commit = owner.port;
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(admission(), authority());
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');

    const result = await controller.dispatchBriefAction(
      retryCommand({ epochId: admitted.epochId, operationId: 'owner-accept' }),
      authority(admitted.projection.stateRevision),
    );

    expect(result).toMatchObject({ kind: 'ready' });
    expect(owner.calls).toHaveLength(4);
    expect(owner.calls[1]?.input.expected.authorityRevision).toBe(1);
    expect(owner.calls[1]?.input.event.type).toBe('brief_recovery_transition');
    expect(owner.calls[2]?.input.expected.authorityRevision).toBe(2);
    expect(owner.calls[2]?.input.event.type).toBe('brief_recovery_transition');
    expect(owner.calls[3]?.input.expected.authorityRevision).toBe(3);
    expect(owner.calls[3]?.input.event.type).toBe('brief_recovery_accepted');
    expect(owner.calls.every((record) => record.result.kind === 'committed')).toBe(true);
    expect(calls.provider).toBe(1);
  });

  it('persists a budget refusal through the owner port with the allowance unconsumed', async () => {
    const calls = { provider: 0 };
    const owner = makeRecordingOwner();
    const deps = makeDependencies(calls);
    deps.commit = owner.port;
    deps.budget.reserve = () => ({
      kind: 'refused',
      code: 'brief_budget_exhausted',
      reason: 'cumulative recovery spend exceeds the configured budget',
    });
    const controller = createBriefRecoveryController(deps);

    const refused = await controller.enterBriefAdmission(standardAdmission(), authority());

    expect(refused).toMatchObject({ kind: 'blocked', code: 'brief_budget_exhausted' });
    expect(owner.calls).toHaveLength(2);
    const record = owner.calls[1];
    if (record === undefined) return;
    expect(record.input.event).toMatchObject({
      type: 'brief_recovery_refused',
      refusalCategory: 'budget',
      refusalCode: 'brief_budget_exhausted',
      action: 'retry',
    });
    expect(record.input.evidence.payload).toMatchObject({
      kind: 'brief-refusal',
      code: 'brief_budget_exhausted',
    });
    expect(record.result.kind).toBe('committed');
    const persisted = normalPersisted(owner.view());
    expect(persisted.automaticRepair).toMatchObject({ eligible: true, consumed: false });
    expect(Object.values(persisted.refusalRetention?.refusals ?? {})[0]).toMatchObject({
      automaticAllowance: { eligible: true, consumed: false },
    });
  });

  it('commits a ready settlement as a parked patch with generation and permit null', async () => {
    const calls = { provider: 0 };
    const owner = makeRecordingOwner();
    const deps = makeDependencies(calls);
    deps.commit = owner.port;
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(admission(), authority());
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');

    const result = await controller.dispatchBriefAction(
      retryCommand({ epochId: admitted.epochId, operationId: 'owner-settle' }),
      authority(admitted.projection.stateRevision),
    );

    expect(result).toMatchObject({ kind: 'ready', projection: { status: 'ready' } });
    const record = owner.calls.at(-1);
    if (record === undefined) return;
    const patch = record.input.projectNext({
      current: record.current,
      evidenceRef: { revision: 1, hash: '0'.repeat(64), path: 'brief-recovery/settle.json' },
      eventId: record.input.event.eventId,
    });
    expect(patch).toMatchObject({
      disposition: 'parked',
      generation: null,
      permit: null,
      authorityRevision: record.input.expected.authorityRevision + 1,
    });
    expect(record.result).toMatchObject({
      kind: 'committed',
      generation: null,
      permit: null,
    });
    if (record.result.kind !== 'committed') return;
    expect(record.result.recovery.briefRecovery).toMatchObject({ status: 'ready' });
  });

  it('commits an edit as one owner commit carrying the edited Brief and refreshed report', async () => {
    const calls = { provider: 0 };
    const owner = makeRecordingOwner();
    const deps = makeDependencies(calls);
    deps.commit = owner.port;
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(admission(), authority());
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');

    const edited = await controller.dispatchBriefAction(
      {
        version: 1,
        sessionId: 'session-1',
        epochId: admitted.epochId,
        operationId: 'owner-edit',
        base: admission().activeBrief,
        intentHash: 'owner-edit-intent',
        action: 'edit',
        briefText: '# Corrected Brief\n',
        newInputId: 'edit-owner-1',
      },
      authority(admitted.projection.stateRevision),
    );

    expect(edited).toMatchObject({ kind: 'ready' });
    expect(owner.calls).toHaveLength(2);
    const record = owner.calls[1];
    if (record === undefined) return;
    expect(record.input.evidence.payload).toMatchObject({ kind: 'brief-edited' });
    expect(record.result.kind).toBe('committed');
    const persisted = normalPersisted(owner.view());
    expect(persisted.activeBrief.hash).not.toBe('brief-hash');
    expect(persisted.status).toBe('ready');
  });

  it('returns a storage blocker without dispatching when the owner commit conflicts', async () => {
    const calls = { provider: 0 };
    const owner = makeRecordingOwner({ conflictOnCommit: 2 });
    const deps = makeDependencies(calls);
    deps.commit = owner.port;
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(admission(), authority());
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');

    const result = await controller.dispatchBriefAction(
      retryCommand({ epochId: admitted.epochId, operationId: 'owner-conflict' }),
      authority(admitted.projection.stateRevision),
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'brief_storage_invalid',
      reason: 'Retry acceptance could not be committed.',
    });
    expect(calls.provider).toBe(0);
    expect(owner.view().stateRevision).toBe(1);
    const status = await controller.dispatchBriefAction(
      { version: 1, sessionId: 'session-1', epochId: admitted.epochId, action: 'status' },
      authority(admitted.projection.stateRevision),
    );
    expect(status.projection.stateRevision).toBe(1);
  });

  it('fails closed when the owner commit throws and keeps the local head unchanged', async () => {
    const calls = { provider: 0 };
    const owner = makeRecordingOwner({ throwOnCommit: 2 });
    const deps = makeDependencies(calls);
    deps.commit = owner.port;
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(admission(), authority());
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');

    const result = await controller.dispatchBriefAction(
      retryCommand({ epochId: admitted.epochId, operationId: 'owner-throw' }),
      authority(admitted.projection.stateRevision),
    );

    expect(result).toMatchObject({
      kind: 'blocked',
      code: 'brief_storage_invalid',
      reason: 'Retry acceptance could not be committed.',
    });
    expect(calls.provider).toBe(0);
    expect(owner.view().stateRevision).toBe(1);
  });

  it('adopts a durability-uncertain commit head and never dispatches twice', async () => {
    const calls = { provider: 0 };
    const owner = makeRecordingOwner({ uncertainOnCommit: 3 });
    const deps = makeDependencies(calls);
    deps.commit = owner.port;
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(admission(), authority());
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');

    const result = await controller.dispatchBriefAction(
      retryCommand({ epochId: admitted.epochId, operationId: 'owner-uncertain' }),
      authority(admitted.projection.stateRevision),
    );

    expect(result).toMatchObject({ kind: 'ready', projection: { status: 'ready' } });
    expect(calls.provider).toBe(1);
    expect(owner.calls).toHaveLength(4);

    const replayed = await controller.dispatchBriefAction(
      retryCommand({ epochId: admitted.epochId, operationId: 'owner-uncertain' }),
      authority(result.projection.stateRevision),
    );
    expect(replayed).toMatchObject({ kind: 'conflict' });
    expect(calls.provider).toBe(1);
    expect(owner.calls).toHaveLength(4);
  });

  it('never issues a generation or permit across the controller commit seam', async () => {
    const calls = { provider: 0 };
    const owner = makeRecordingOwner();
    const deps = makeDependencies(calls);
    deps.commit = owner.port;
    const controller = createBriefRecoveryController(deps);
    const admitted = await controller.enterBriefAdmission(admission(), authority());
    if (admitted.epochId === null) throw new Error('admission has no recovery epoch');

    const result = await controller.dispatchBriefAction(
      retryCommand({ epochId: admitted.epochId, operationId: 'owner-boundary' }),
      authority(admitted.projection.stateRevision),
    );

    expect(result).toMatchObject({ kind: 'ready' });
    expect(owner.calls.length).toBeGreaterThanOrEqual(4);
    for (const record of owner.calls) {
      expect([
        'brief_recovery_refused',
        'brief_recovery_accepted',
        'brief_recovery_transition',
      ]).toContain(record.input.event.type);
      const patch = record.input.projectNext({
        current: owner.view(),
        evidenceRef: { revision: 1, hash: '0'.repeat(64), path: 'brief-recovery/boundary.json' },
        eventId: record.input.event.eventId,
      });
      expect(patch.generation).toBeNull();
      expect(patch.permit).toBeNull();
      expect(record.result.generation).toBeNull();
      expect(record.result.permit).toBeNull();
    }
    expect(BriefRecoveryStateViewSchema.safeParse(owner.view()).success).toBe(true);
  });
});
