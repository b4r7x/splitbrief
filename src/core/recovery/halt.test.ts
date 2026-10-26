import { describe, expect, it } from 'vitest';
import { RECOVERY_REASONS, RETIRED_RECOVERY_REASONS } from '../schemas/enums.js';
import {
  allowedActionsForHalt,
  haltOf,
  isRetiredRecoveryReason,
  recoveryHaltLabel,
} from './halt.js';

describe('recovery halts', () => {
  it('puts every cause a seat cannot get past on seat down', () => {
    const seatDown = RECOVERY_REASONS.filter((reason) => haltOf(reason) === 'seat-down');
    expect(seatDown.toSorted()).toEqual(
      [
        'context-overflow',
        'implementer-left-isolation',
        'implementer-recipe-invalid',
        'planner-call-failed',
        'review-input-too-large',
        'runner-timeout-repeated',
        'runner-unauthenticated',
        'runner-usage-limit',
        'seat-protocol-error',
      ].toSorted(),
    );
  });

  it('puts every decision, spent bound and retired cause on needs you', () => {
    expect(haltOf('consult-bound-spent')).toBe('needs-you');
    expect(haltOf('review-failed')).toBe('needs-you');
    expect(haltOf('apply-conflict')).toBe('needs-you');
    for (const reason of RETIRED_RECOVERY_REASONS) expect(haltOf(reason)).toBe('needs-you');
  });

  it('offers a seat down halt the seat picker and never a grant or a revision', () => {
    const seatDown = allowedActionsForHalt('seat-down');
    expect(seatDown).toContain('switch-seat');
    expect(seatDown).not.toContain('continue');
    expect(seatDown).not.toContain('revise');
    expect(allowedActionsForHalt('needs-you')).not.toContain('switch-seat');
  });

  it('offers a seat down halt a wait for the reset, and no other halt one', () => {
    expect(allowedActionsForHalt('seat-down')).toContain('retry-later');
    expect(allowedActionsForHalt('needs-you')).not.toContain('retry-later');
  });

  it('tells a retired cause from a live one', () => {
    expect(isRetiredRecoveryReason('user-edit-conflict')).toBe(true);
    expect(isRetiredRecoveryReason('retry-exhausted')).toBe(false);
  });

  it('names the halt before the cause', () => {
    expect(recoveryHaltLabel('seat-down')).toBe('Seat down');
    expect(recoveryHaltLabel('needs-you')).toBe('Needs you');
  });
});
