import { describe, expect, it } from 'vitest';
import { BriefRecoveryV1Schema } from '../../../core/schemas/brief-recovery.js';
import type {
  BriefAdmissionInput,
  BriefRecoveryV1,
  BudgetReservation,
  EvidenceRef,
  NormalBriefRecoveryV1,
  RecoveryUsage,
} from '../../../core/schemas/brief-recovery.js';
import {
  acceptRecoveryOperation,
  automaticRepairIntent,
  briefRecoveryDiagnosticFingerprint,
  closeRecoveryRefusalEpoch,
  createBriefRecoveryState,
  deriveAllowedActions,
  deriveRecoveryBlocker,
  inspectBriefRecovery,
  queueRecoveryInput,
  reconcileLostOwner,
  reconcileRecoveryReservation,
  reduceBriefRecovery,
  refuseRecoveryOperation,
  rejectBriefRecovery,
  resolveUnresolvedOperation,
  settleRecoveryOperation,
  startRecoveryOperation,
  supersedeRecoveryOperation,
  terminalChargeRecoveryReservations,
} from './brief-recovery.js';
import type { RecoveryOperationInput, RecoveryRefusalInput } from './brief-recovery.js';

const ref = (path: string, hash = path): EvidenceRef => ({ revision: 1, hash, path });
const usage: RecoveryUsage = { inputTokens: 2, outputTokens: 3, totalTokens: 5, estimated: false };
const input: BriefAdmissionInput = {
  sessionId: 'session-1',
  origin: { mode: 'standard', entry: 'initial' },
  continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
  activeBrief: ref('tasks.md', 'brief-1'),
  report: {
    briefHash: 'brief-1',
    report: ref('brief-quality.json', 'report-1'),
    ruleVersion: 'quality-v1',
    issues: [
      {
        code: 'missing_acceptance',
        severity: 'error',
        taskId: null,
        message: 'Missing acceptance',
      },
    ],
    errorCount: 1,
  },
  qualityPolicyVersion: 'quality-v1',
};

const reservation = (
  operationId: string,
  state: 'reserved' | 'held' = 'reserved',
): BudgetReservation => ({
  accountingKey: { sessionId: 'session-1', epochId: 'epoch-1', operationId, generation: 1 },
  amount: 1,
  state,
  usageApplied: false,
  appliedUsage: null,
  history: [{ state, at: 't0', reason: state === 'reserved' ? 'accepted' : 'unresolved' }],
});

function operation(
  operationId: string,
  kind: 'automatic' | 'manual-retry' = 'manual-retry',
): RecoveryOperationInput {
  return {
    epochId: 'epoch-1',
    operationId,
    intentHash: `${operationId}-intent`,
    kind,
    acceptedAt: 't1',
    baseBrief: ref('tasks.md', 'brief-1'),
    baseReport: ref('brief-quality.json', 'report-1'),
    frozenInputIds: [],
    reservation: reservation(operationId),
  };
}

function normal(state: BriefRecoveryV1): NormalBriefRecoveryV1 {
  if (state.status === 'storage-blocked' || state.status === 'rejected')
    throw new Error('expected normal recovery');
  return state;
}

function settled(
  operationId: string,
  outcome: 'quality-failed' | 'ready' | 'provider-failed',
  remoteObservation: 'confirmed-final' | 'not-dispatched' = 'confirmed-final',
) {
  return {
    sessionId: 'session-1',
    epochId: 'epoch-1',
    operationId,
    requestId: remoteObservation === 'confirmed-final' ? `${operationId}-request` : null,
    dispatchPossibility:
      remoteObservation === 'confirmed-final' ? ('possible' as const) : ('none' as const),
    remoteObservation,
    outcome,
    candidate: null,
    report: null,
    providerCode: outcome === 'provider-failed' ? 'quota' : null,
    usage: remoteObservation === 'confirmed-final' ? usage : null,
    settledAt: 't4',
  };
}

describe('brief recovery reducer', () => {
  it('opens blocked admission, consumes automatic allowance at acceptance, and replays IDs', () => {
    const state = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    expect(state.status).toBe('blocked');
    const accepted = acceptRecoveryOperation(state, operation('auto-1', 'automatic'), 't1');
    expect(accepted.kind).toBe('accepted');
    expect(accepted.state).toMatchObject({ status: 'auto-repairing', activeOperationId: 'auto-1' });
    if (accepted.kind !== 'accepted') return;
    expect(normal(accepted.state).automaticRepair).toMatchObject({
      consumed: true,
      operationId: 'auto-1',
    });
    const replay = acceptRecoveryOperation(accepted.state, operation('auto-1', 'automatic'), 't2');
    expect(replay.kind).toBe('replayed');
    expect(replay.state).toEqual(accepted.state);
    const conflict = acceptRecoveryOperation(
      accepted.state,
      { ...operation('auto-1', 'automatic'), intentHash: 'other' },
      't2',
    );
    expect(conflict.kind).toBe('conflict');
  });

  it('keeps definite failure, confirmed-final usage, and ambiguous outcomes distinct', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const pre = acceptRecoveryOperation(base, operation('pre'), 't1');
    const preSettled = settleRecoveryOperation(
      pre.state,
      settled('pre', 'provider-failed', 'not-dispatched'),
    );
    expect(preSettled.state).toMatchObject({ status: 'blocked', activeOperationId: null });
    expect(preSettled.receipt?.status).toBe('settled');
    expect(preSettled.receipt?.dispatchPossibility).toBe('none');
    expect(preSettled.receipt?.reservation.state).toBe('released');

    const active = startRecoveryOperation(
      acceptRecoveryOperation(base, operation('post'), 't1').state,
      { operationId: 'post', requestId: 'post-request', startedAt: 't2' },
    );
    const post = settleRecoveryOperation(active.state, settled('post', 'provider-failed'));
    expect(post.receipt?.reservation.state).toBe('reconciled');
    expect(post.receipt?.reservation.appliedUsage).toEqual(usage);

    const ambiguousAccepted = acceptRecoveryOperation(base, operation('ambiguous'), 't1');
    const ambiguousStarted = startRecoveryOperation(ambiguousAccepted.state, {
      operationId: 'ambiguous',
      requestId: 'ambiguous-request',
      startedAt: 't2',
    });
    const unresolved = settleRecoveryOperation(ambiguousStarted.state, {
      ...settled('ambiguous', 'provider-failed'),
      remoteObservation: 'unknown',
      usage: null,
    });
    expect(unresolved.kind).toBe('unresolved');
    expect(unresolved.state.status).toBe('unresolved');
    expect(unresolved.receipt?.reservation.state).toBe('held');
  });

  it('preserves superseded resource semantics before and after dispatch', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const accepted = acceptRecoveryOperation(base, operation('none'), 't1');
    const none = supersedeRecoveryOperation(accepted.state, {
      operationId: 'none',
      reason: 'edit',
      at: 't2',
    });
    expect(none.receipt).toMatchObject({
      status: 'superseded',
      dispatchPossibility: 'none',
      resourceDisposition: 'released',
    });
    expect(none.receipt?.reservation.state).toBe('released');

    const started = startRecoveryOperation(
      acceptRecoveryOperation(base, operation('possible'), 't1').state,
      { operationId: 'possible', requestId: 'possible-request', startedAt: 't2' },
    );
    const possible = supersedeRecoveryOperation(started.state, {
      operationId: 'possible',
      reason: 'edit',
      at: 't3',
    });
    expect(possible.receipt).toMatchObject({
      status: 'superseded',
      dispatchPossibility: 'possible',
      resourceDisposition: 'held-superseded',
    });
    expect(possible.receipt?.reservation.state).toBe('held');
    const late = settleRecoveryOperation(possible.state, settled('possible', 'ready'));
    expect(late.kind).toBe('stale-ignored');
    expect(late.state).toEqual(possible.state);
  });

  it('requires explicit unresolved resolution and preserves the old receipt', () => {
    const queued = queueRecoveryInput(
      createBriefRecoveryState(input, { epochId: 'epoch-1' }),
      {
        inputId: 'feedback-1',
        epochId: 'epoch-1',
        sequence: 1,
        kind: 'feedback',
        source: 'typed',
        payload: 'try again',
        base: ref('tasks.md', 'brief-1'),
        operationId: null,
      },
      't0',
    );
    const accepted = acceptRecoveryOperation(
      queued.state,
      { ...operation('unresolved'), frozenInputIds: ['feedback-1'] },
      't1',
    );
    const started = startRecoveryOperation(accepted.state, {
      operationId: 'unresolved',
      requestId: 'request-1',
      startedAt: 't2',
    });
    const unresolved = reconcileLostOwner(started.state, 'unresolved', 't3');
    const rebound = resolveUnresolvedOperation(unresolved.state, {
      operationId: 'unresolved',
      heldInputIds: ['feedback-1'],
      resolution: { kind: 'rebind', acknowledgeRemoteDuplicationRisk: true },
      at: 't4',
    });
    expect(rebound.kind).toBe('rebound');
    expect(normal(rebound.state).attempts.unresolved?.status).toBe('unresolved');
    expect(normal(rebound.state).inputs[0]?.state).toBe('carried');
    expect(normal(rebound.state).attempts.unresolved?.reservation.state).toBe('held');
  });

  it('charges all possible held reservations on closure and makes it replay-safe', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const first = reconcileLostOwner(
      startRecoveryOperation(acceptRecoveryOperation(base, operation('one'), 't1').state, {
        operationId: 'one',
        requestId: 'r1',
        startedAt: 't2',
      }).state,
      'one',
      't3',
    );
    const released = resolveUnresolvedOperation(first.state, {
      operationId: 'one',
      heldInputIds: [],
      resolution: { kind: 'rebind', acknowledgeRemoteDuplicationRisk: true },
      at: 't3b',
    });
    const second = reconcileLostOwner(
      startRecoveryOperation(
        acceptRecoveryOperation(released.state, operation('two'), 't4').state,
        { operationId: 'two', requestId: 'r2', startedAt: 't5' },
      ).state,
      'two',
      't6',
    );
    const charged = terminalChargeRecoveryReservations(second.state, 't7');
    expect(normal(charged.state).attempts.one?.reservation.state).toBe('terminal-charged');
    expect(normal(charged.state).attempts.two?.reservation.state).toBe('terminal-charged');
    expect(terminalChargeRecoveryReservations(charged.state, 't8').state).toEqual(charged.state);
    expect(rejectBriefRecovery(charged.state, 't9').state.status).toBe('rejected');
  });

  it('derives action and diagnostic precedence without persisting allowed actions', () => {
    const state = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    expect(deriveAllowedActions(state)).toContain('retry');
    expect(deriveRecoveryBlocker(state)?.kind).toBe('quality');
    const projection = inspectBriefRecovery({ sessionId: 'session-1', stateRevision: 4, state });
    expect(projection.allowedActions).toContain('retry');
    expect(projection.blocker?.kind).toBe('quality');
    expect('allowedActions' in state).toBe(false);
    expect(
      briefRecoveryDiagnosticFingerprint('brief', 'quality-v1', input.report.issues),
    ).toHaveLength(64);
    expect(BriefRecoveryV1Schema.safeParse(state).success).toBe(true);
  });

  it('keeps possible no-usage settlement held until closure', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const started = startRecoveryOperation(
      acceptRecoveryOperation(base, operation('unknown'), 't1').state,
      { operationId: 'unknown', requestId: 'r1', startedAt: 't2' },
    );
    const result = settleRecoveryOperation(started.state, {
      ...settled('unknown', 'provider-failed'),
      requestId: 'r1',
      usage: null,
    });
    expect(result.receipt?.reservation.state).toBe('held');
    const reconciled = reconcileRecoveryReservation(result.state, 'unknown', null, 't5');
    expect(reconciled.receipt?.reservation.state).toBe('held');
    expect(
      normal(terminalChargeRecoveryReservations(result.state, 't6').state).attempts.unknown
        ?.reservation.state,
    ).toBe('terminal-charged');
  });

  it('bounds settled attempt history without blocking later attempts', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const started = startRecoveryOperation(
      acceptRecoveryOperation(base, operation('unresolved-history'), '000').state,
      { operationId: 'unresolved-history', requestId: 'request-history', startedAt: '001' },
    );
    const unresolved = reconcileLostOwner(started.state, 'unresolved-history', '002');
    let state: BriefRecoveryV1 = resolveUnresolvedOperation(unresolved.state, {
      operationId: 'unresolved-history',
      heldInputIds: [],
      resolution: { kind: 'rebind', acknowledgeRemoteDuplicationRisk: true },
      at: '003',
    }).state;

    for (let index = 0; index < 300; index += 1) {
      const operationId = `attempt-${index}`;
      const at = String(index + 10).padStart(3, '0');
      const accepted = acceptRecoveryOperation(
        state,
        { ...operation(operationId), acceptedAt: at },
        at,
      );
      const completed = settleRecoveryOperation(accepted.state, {
        ...settled(operationId, 'provider-failed', 'not-dispatched'),
        settledAt: at,
      });
      state = completed.state;
    }

    expect(Object.keys(normal(state).attempts)).toHaveLength(257);
    expect(normal(state).attempts['unresolved-history']?.status).toBe('unresolved');
    expect(normal(state).attempts['attempt-0']).toBeUndefined();
    expect(normal(state).attempts['attempt-299']?.status).toBe('settled');
    expect(BriefRecoveryV1Schema.safeParse(state).success).toBe(true);
  });

  it('projects the chronologically latest attempt when operation IDs sort out of order', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const older = acceptRecoveryOperation(
      base,
      { ...operation('z-old'), acceptedAt: '2026-08-13T12:00:00.000Z' },
      '2026-08-13T12:00:00.000Z',
    );
    const olderSettled = settleRecoveryOperation(older.state, {
      ...settled('z-old', 'provider-failed', 'not-dispatched'),
      settledAt: '2026-08-13T12:01:00.000Z',
    });
    const newer = acceptRecoveryOperation(
      olderSettled.state,
      { ...operation('a-new'), acceptedAt: '2026-08-13T12:02:00.000Z' },
      '2026-08-13T12:02:00.000Z',
    );
    const newerSettled = settleRecoveryOperation(newer.state, {
      ...settled('a-new', 'provider-failed', 'not-dispatched'),
      settledAt: '2026-08-13T12:03:00.000Z',
    });

    expect(
      inspectBriefRecovery({ sessionId: 'session-1', stateRevision: 4, state: newerSettled.state })
        .latestAttempt?.operationId,
    ).toBe('a-new');
  });
});

function refusal(
  operationId: string,
  overrides: Partial<RecoveryRefusalInput> = {},
): RecoveryRefusalInput {
  return {
    epochId: 'epoch-1',
    operationId,
    intentHash: `${operationId}-intent`,
    action: 'retry',
    code: 'brief_budget_unknown',
    category: 'budget',
    reasonCode: 'brief_budget_unknown',
    accountingKey: null,
    budgetPolicy: 'no-dollar-cap',
    configuredCap: null,
    priceKnownness: 'provider-dependent',
    spendKnownness: 'unknown-paid',
    evidence: ref('brief-recovery/refusal.json', `refusal-${operationId}`),
    ...overrides,
  };
}

describe('brief recovery refusal retention', () => {
  it('refuses an automatic repair while preserving the eligible unconsumed allowance', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const automatic = automaticRepairIntent(normal(base));
    const refused = refuseRecoveryOperation(
      base,
      refusal('auto-1', { intentHash: automatic }),
      't1',
    );
    expect(refused.kind).toBe('refused');
    expect(refused.code).toBe('brief_budget_unknown');
    expect(normal(refused.state).automaticRepair).toMatchObject({
      eligible: true,
      consumed: false,
      operationId: null,
    });
    expect(normal(refused.state).attempts['auto-1']).toBeUndefined();
    expect(normal(refused.state).status).toBe('blocked');
    const replay = refuseRecoveryOperation(
      refused.state,
      refusal('auto-1', { intentHash: automatic }),
      't2',
    );
    expect(replay.kind).toBe('replayed');
    expect(replay.state).toEqual(refused.state);
    expect(BriefRecoveryV1Schema.safeParse(refused.state).success).toBe(true);
  });

  it('conflicts instead of retaining a refusal for an operation that already holds an attempt', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const accepted = acceptRecoveryOperation(base, operation('op-1'), 't1');
    const conflict = refuseRecoveryOperation(accepted.state, refusal('op-1'), 't2');
    expect(conflict.kind).toBe('conflict');
    expect(conflict.receipt?.status).toBe('accepted');
    expect(conflict.state).toEqual(accepted.state);
    expect(normal(conflict.state).refusalRetention).toBeUndefined();
  });

  it('replays a retained refusal before any estimate without advancing revision', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const refused = refuseRecoveryOperation(base, refusal('op-1'), 't1');
    expect(refused.kind).toBe('refused');
    const before = normal(refused.state).recoveryRevision;
    const replay = acceptRecoveryOperation(refused.state, operation('op-1'), 't2');
    expect(replay.kind).toBe('replayed');
    expect(replay.state).toEqual(refused.state);
    expect(normal(replay.state).recoveryRevision).toBe(before);
    const conflict = acceptRecoveryOperation(
      refused.state,
      { ...operation('op-1'), intentHash: 'other' },
      't2',
    );
    expect(conflict.kind).toBe('conflict');
  });

  it('compacts 17 refusal epochs into 16 summaries and keeps current replay exact', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    let state: BriefRecoveryV1 = base;
    for (let index = 1; index <= 17; index += 1) {
      const epochId = `epoch-${index}`;
      const nextEpoch = `epoch-${index + 1}`;
      const at = `t-${String(index).padStart(2, '0')}`;
      const refused = refuseRecoveryOperation(
        state,
        refusal(`refused-${index}`, { epochId, intentHash: `intent-${index}` }),
        at,
      );
      expect(refused.kind).toBe('refused');
      const closed = closeRecoveryRefusalEpoch(
        refused.state,
        { newEpochId: nextEpoch, closedAt: at, evidenceHead: `head-${index}` },
        at,
      );
      expect(closed.kind).toBe('epoch-closed');
      state = closed.state;
    }
    const retention = normal(state).refusalRetention;
    expect(retention).toBeDefined();
    if (retention === undefined) return;
    expect(retention.closedEpochSummaries).toHaveLength(16);
    expect(retention.closedEpochSummaries[0]?.epochId).toBe('epoch-17');
    expect(retention.closedEpochSummaries.at(-1)?.epochId).toBe('epoch-2');
    expect(retention.closedEpochSummaries.some((summary) => summary.epochId === 'epoch-1')).toBe(
      false,
    );
    expect(retention.currentEpochId).toBe('epoch-18');

    const current = refuseRecoveryOperation(
      state,
      refusal('current-op', { epochId: 'epoch-18' }),
      't-18',
    );
    expect(current.kind).toBe('refused');
    const replay = acceptRecoveryOperation(
      current.state,
      { ...operation('current-op'), epochId: 'epoch-18' },
      't-19',
    );
    expect(replay.kind).toBe('replayed');
    expect(replay.state).toEqual(current.state);
    expect(BriefRecoveryV1Schema.safeParse(current.state).success).toBe(true);
  });

  it('routes refusal and epoch-close actions through the exhaustive reducer', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const refused = reduceBriefRecovery(base, { type: 'refuse', input: refusal('op-1'), at: 't1' });
    if ('input' in refused) throw new Error('expected a recovery mutation');
    expect(refused.kind).toBe('refused');
    const closed = reduceBriefRecovery(refused.state, {
      type: 'close-epoch',
      input: { newEpochId: 'epoch-2', closedAt: 't2' },
      at: 't2',
    });
    if ('input' in closed) throw new Error('expected a recovery mutation');
    expect(closed.kind).toBe('epoch-closed');
    expect(normal(closed.state).refusalRetention?.currentEpochId).toBe('epoch-2');
  });
});
