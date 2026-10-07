import { describe, expect, it } from 'vitest';
import type { SwitchSeatOffer } from '../schemas/recovery/schemas.js';
import { recoveryActionLabel } from './action-label.js';

describe('recoveryActionLabel for a seat swap', () => {
  it.each([
    ['plan', 'Change PLAN tool'],
    ['build', 'Change BUILD tool'],
    ['review', 'Change REVIEW tool'],
  ] as const)('names the %s seat the halt stopped', (seat, label) => {
    const offer: SwitchSeatOffer = { seat, candidates: [{ tool: 'codex' }] };

    expect(recoveryActionLabel('switch-seat', { switchSeat: offer })).toBe(label);
    expect(recoveryActionLabel('switch-seat', { seat })).toBe(label);
  });

  it('names no seat when nothing says which one halted', () => {
    expect(recoveryActionLabel('switch-seat')).toBe('Change tool');
  });
});

describe('recoveryActionLabel for a wait', () => {
  it('names the clock a retry-later waits for', () => {
    const resetAt = new Date(new Date().setHours(17, 0, 0, 0)).toISOString();

    expect(recoveryActionLabel('retry-later', { resetAt })).toBe('Retry at 17:00');
  });

  it('says only that it waits when the halt names no clock', () => {
    expect(recoveryActionLabel('retry-later')).toBe('Retry later');
  });
});
