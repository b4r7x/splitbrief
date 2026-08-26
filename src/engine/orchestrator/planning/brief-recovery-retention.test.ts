import { describe, expect, it } from 'vitest';
import { BriefRecoveryV1Schema } from '../../../core/schemas/brief-recovery/document.js';
import type { BriefRecoveryV1 } from '../../../core/schemas/brief-recovery/document.js';
import {
  automaticRepairIntent,
  closeRecoveryRefusalEpoch,
  createBriefRecoveryState,
  deriveAllowedActions,
  deriveRecoveryBlocker,
  inspectBriefRecovery,
  refuseRecoveryOperation,
} from './brief-recovery.js';
import {
  normalRecovery,
  recoveryRefusal,
  standardAdmissionInput,
} from '#testing/helpers/factories/brief-recovery.js';

describe('brief recovery refusal retention bounds', () => {
  it('storage-refuses a 65th current-epoch refusal without growing state', () => {
    let state: BriefRecoveryV1 = createBriefRecoveryState(standardAdmissionInput, {
      epochId: 'epoch-1',
    });
    for (let index = 1; index <= 64; index += 1) {
      const result = refuseRecoveryOperation(
        state,
        recoveryRefusal(`refused-${index}`),
        `t${index}`,
      );
      expect(result.kind).toBe('refused');
      state = result.state;
    }
    const before = JSON.stringify(state);
    const overflow = refuseRecoveryOperation(state, recoveryRefusal('overflow'), 't65');
    expect(overflow.kind).toBe('blocked');
    expect(overflow.code).toBe('brief_storage_invalid');
    expect(overflow.state).toEqual(state);
    expect(JSON.stringify(overflow.state)).toBe(before);
    expect(normalRecovery(state).refusalRetention?.refusals['overflow']).toBeUndefined();
    expect(normalRecovery(state).refusalRetention?.refusals['refused-64']).toBeDefined();
    expect(BriefRecoveryV1Schema.safeParse(state).success).toBe(true);
  });

  it('storage-refuses a refusal receipt beyond the 1 KiB bound', () => {
    const base = createBriefRecoveryState(standardAdmissionInput, { epochId: 'epoch-1' });
    const result = refuseRecoveryOperation(
      base,
      recoveryRefusal('big', { reason: 'x'.repeat(2_500) }),
      't1',
    );
    expect(result.kind).toBe('blocked');
    expect(result.code).toBe('brief_storage_invalid');
    expect(result.state).toEqual(base);
    expect(BriefRecoveryV1Schema.safeParse(base).success).toBe(true);
  });

  it('loads legacy state without retention and seeds it on first refusal', () => {
    const base = createBriefRecoveryState(standardAdmissionInput, { epochId: 'epoch-1' });
    expect('refusalRetention' in base).toBe(false);
    const refused = refuseRecoveryOperation(base, recoveryRefusal('op-1'), 't1');
    expect(refused.kind).toBe('refused');
    expect(normalRecovery(refused.state).refusalRetention).toMatchObject({
      currentEpochId: 'epoch-1',
      closedEpochSummaries: [],
    });
    expect(normalRecovery(refused.state).refusalRetention?.refusals['op-1']).toMatchObject({
      epochId: 'epoch-1',
      operationId: 'op-1',
      automaticAllowance: { eligible: true, consumed: false },
    });
    expect(BriefRecoveryV1Schema.safeParse(refused.state).success).toBe(true);
  });

  it('hydrates a persisted refusal retention into an admitted state and replays it', () => {
    const source = refuseRecoveryOperation(
      createBriefRecoveryState(standardAdmissionInput, { epochId: 'epoch-1' }),
      recoveryRefusal('op-1'),
      't1',
    ).state;
    const retained = normalRecovery(source).refusalRetention;
    expect(retained).toBeDefined();
    if (retained === undefined) return;
    const hydrated = createBriefRecoveryState(standardAdmissionInput, {
      epochId: 'epoch-1',
      refusalRetention: retained,
    });
    expect(normalRecovery(hydrated).refusalRetention).toEqual(retained);
    const replay = refuseRecoveryOperation(hydrated, recoveryRefusal('op-1'), 't2');
    expect(replay.kind).toBe('replayed');
    expect(replay.state).toEqual(hydrated);
    expect(BriefRecoveryV1Schema.safeParse(hydrated).success).toBe(true);
  });

  it('closes an empty retention epoch without creating a summary and replays the same target', () => {
    const base = createBriefRecoveryState(standardAdmissionInput, { epochId: 'epoch-1' });
    const closed = closeRecoveryRefusalEpoch(base, { newEpochId: 'epoch-2', closedAt: 't1' }, 't1');
    expect(closed.kind).toBe('epoch-closed');
    expect(normalRecovery(closed.state).refusalRetention).toMatchObject({
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
    const base = createBriefRecoveryState(standardAdmissionInput, { epochId: 'epoch-1' });
    const automatic = automaticRepairIntent(normalRecovery(base));
    const refused = refuseRecoveryOperation(
      base,
      recoveryRefusal('auto-intent', { intentHash: automatic }),
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
    expect(normalRecovery(closed.state).refusalRetention?.refusals['auto-intent']).toBeDefined();
  });

  it('observes refusal state without mutating or advancing it', () => {
    const base = createBriefRecoveryState(standardAdmissionInput, { epochId: 'epoch-1' });
    const refused = refuseRecoveryOperation(base, recoveryRefusal('op-1'), 't1').state;
    const before = JSON.stringify(refused);
    const revision = normalRecovery(refused).recoveryRevision;
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
    expect(normalRecovery(refused).recoveryRevision).toBe(revision);
    expect(JSON.stringify(refused)).toBe(before);
    expect(BriefRecoveryV1Schema.safeParse(refused).success).toBe(true);
  });

  it('projects a no-progress refusal as the no-progress blocker', () => {
    const base = createBriefRecoveryState(standardAdmissionInput, { epochId: 'epoch-1' });
    const refused = refuseRecoveryOperation(
      base,
      recoveryRefusal('op-1', {
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
      fingerprint: normalRecovery(refused.state).noProgress.fingerprint,
      count: 0,
    });
  });
});
