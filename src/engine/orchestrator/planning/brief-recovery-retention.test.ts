import { describe, expect, it } from 'vitest';
import { BriefRecoveryV1Schema } from '../../../core/schemas/brief-recovery.js';
import type {
  BriefAdmissionInput,
  BriefRecoveryV1,
  EvidenceRef,
  NormalBriefRecoveryV1,
} from '../../../core/schemas/brief-recovery.js';
import {
  automaticRepairIntent,
  closeRecoveryRefusalEpoch,
  createBriefRecoveryState,
  deriveAllowedActions,
  deriveRecoveryBlocker,
  inspectBriefRecovery,
  refuseRecoveryOperation,
  type RecoveryRefusalInput,
} from './brief-recovery.js';

const ref = (path: string, hash = path): EvidenceRef => ({ revision: 1, hash, path });
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

function normal(state: BriefRecoveryV1): NormalBriefRecoveryV1 {
  if (state.status === 'storage-blocked' || state.status === 'rejected')
    throw new Error('expected normal recovery');
  return state;
}

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

describe('brief recovery refusal retention bounds', () => {
  it('storage-refuses a 65th current-epoch refusal without growing state', () => {
    let state: BriefRecoveryV1 = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    for (let index = 1; index <= 64; index += 1) {
      const result = refuseRecoveryOperation(state, refusal(`refused-${index}`), `t${index}`);
      expect(result.kind).toBe('refused');
      state = result.state;
    }
    const before = JSON.stringify(state);
    const overflow = refuseRecoveryOperation(state, refusal('overflow'), 't65');
    expect(overflow.kind).toBe('blocked');
    expect(overflow.code).toBe('brief_storage_invalid');
    expect(overflow.state).toEqual(state);
    expect(JSON.stringify(overflow.state)).toBe(before);
    expect(normal(state).refusalRetention?.refusals['overflow']).toBeUndefined();
    expect(normal(state).refusalRetention?.refusals['refused-64']).toBeDefined();
    expect(BriefRecoveryV1Schema.safeParse(state).success).toBe(true);
  });

  it('storage-refuses a refusal receipt beyond the 1 KiB bound', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const result = refuseRecoveryOperation(
      base,
      refusal('big', { reason: 'x'.repeat(2_500) }),
      't1',
    );
    expect(result.kind).toBe('blocked');
    expect(result.code).toBe('brief_storage_invalid');
    expect(result.state).toEqual(base);
    expect(BriefRecoveryV1Schema.safeParse(base).success).toBe(true);
  });

  it('loads legacy state without retention and seeds it on first refusal', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    expect('refusalRetention' in base).toBe(false);
    const refused = refuseRecoveryOperation(base, refusal('op-1'), 't1');
    expect(refused.kind).toBe('refused');
    expect(normal(refused.state).refusalRetention).toMatchObject({
      currentEpochId: 'epoch-1',
      closedEpochSummaries: [],
    });
    expect(normal(refused.state).refusalRetention?.refusals['op-1']).toMatchObject({
      epochId: 'epoch-1',
      operationId: 'op-1',
      automaticAllowance: { eligible: true, consumed: false },
    });
    expect(BriefRecoveryV1Schema.safeParse(refused.state).success).toBe(true);
  });

  it('hydrates a persisted refusal retention into an admitted state and replays it', () => {
    const source = refuseRecoveryOperation(
      createBriefRecoveryState(input, { epochId: 'epoch-1' }),
      refusal('op-1'),
      't1',
    ).state;
    const retained = normal(source).refusalRetention;
    expect(retained).toBeDefined();
    if (retained === undefined) return;
    const hydrated = createBriefRecoveryState(input, {
      epochId: 'epoch-1',
      refusalRetention: retained,
    });
    expect(normal(hydrated).refusalRetention).toEqual(retained);
    const replay = refuseRecoveryOperation(hydrated, refusal('op-1'), 't2');
    expect(replay.kind).toBe('replayed');
    expect(replay.state).toEqual(hydrated);
    expect(BriefRecoveryV1Schema.safeParse(hydrated).success).toBe(true);
  });

  it('closes an empty retention epoch without creating a summary and replays the same target', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const closed = closeRecoveryRefusalEpoch(base, { newEpochId: 'epoch-2', closedAt: 't1' }, 't1');
    expect(closed.kind).toBe('epoch-closed');
    expect(normal(closed.state).refusalRetention).toMatchObject({
      currentEpochId: 'epoch-2',
      closedEpochSummaries: [],
    });
    const replay = closeRecoveryRefusalEpoch(
      closed.state,
      { newEpochId: 'epoch-2', closedAt: 't2' },
      't2',
    );
    expect(replay.kind).toBe('replayed');
    expect(replay.state).toEqual(closed.state);
  });

  it('refuses to evict the current automatic repair intent refusal', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const automatic = automaticRepairIntent(normal(base));
    const refused = refuseRecoveryOperation(
      base,
      refusal('auto-intent', { intentHash: automatic }),
      't1',
    );
    expect(refused.kind).toBe('refused');
    const closed = closeRecoveryRefusalEpoch(
      refused.state,
      { newEpochId: 'epoch-2', closedAt: 't2' },
      't2',
    );
    expect(closed.kind).toBe('conflict');
    expect(closed.state).toEqual(refused.state);
    expect(normal(closed.state).refusalRetention?.refusals['auto-intent']).toBeDefined();
  });

  it('observes refusal state without mutating or advancing it', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const refused = refuseRecoveryOperation(base, refusal('op-1'), 't1').state;
    const before = JSON.stringify(refused);
    const revision = normal(refused).recoveryRevision;
    const projection = inspectBriefRecovery({
      sessionId: 'session-1',
      stateRevision: 4,
      state: refused,
    });
    expect(projection.blocker).toMatchObject({ kind: 'budget', code: 'brief_budget_unknown' });
    expect(projection.allowedActions).toContain('retry');
    expect(deriveRecoveryBlocker(refused)).toMatchObject({
      kind: 'budget',
      code: 'brief_budget_unknown',
    });
    expect(deriveAllowedActions(refused)).toContain('retry');
    expect(normal(refused).recoveryRevision).toBe(revision);
    expect(JSON.stringify(refused)).toBe(before);
    expect(BriefRecoveryV1Schema.safeParse(refused).success).toBe(true);
  });

  it('projects a no-progress refusal as the no-progress blocker', () => {
    const base = createBriefRecoveryState(input, { epochId: 'epoch-1' });
    const refused = refuseRecoveryOperation(
      base,
      refusal('op-1', {
        code: 'brief_no_progress',
        category: 'policy',
        reasonCode: 'brief_no_progress',
      }),
      't1',
    );
    expect(refused.kind).toBe('refused');
    expect(deriveRecoveryBlocker(refused.state)).toMatchObject({
      kind: 'no-progress',
      code: 'brief_no_progress',
      fingerprint: normal(refused.state).noProgress.fingerprint,
      count: 0,
    });
  });
});
