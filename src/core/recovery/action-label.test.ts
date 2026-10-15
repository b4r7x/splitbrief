import { describe, expect, it } from 'vitest';
import type { SwitchSeatOffer } from '../schemas/recovery/schemas.js';
import { recoveryActionLabel, recoveryActionParts } from './action-label.js';

describe('recoveryActionLabel for a seat swap', () => {
  it.each([
    ['plan', 'Change PLAN tool'],
    ['build', 'Change BUILD tool'],
    ['review', 'Change REVIEW tool'],
  ] as const)('names the %s seat the halt stopped', (seat, label) => {
    const offer: SwitchSeatOffer = { seat, candidates: [{ tool: 'codex' }] };

    expect(recoveryActionLabel('switch-seat', { switchSeat: offer })).toBe(label);
    expect(recoveryActionLabel('switch-seat', { seat })).toBe(label);
    expect(recoveryActionParts('switch-seat', { seat })).toEqual([
      { text: 'Change ' },
      { text: seat.toUpperCase(), seat },
      { text: ' tool' },
    ]);
    expect(recoveryActionParts('retry-same-worker', { seatRetry: seat })).toEqual([
      { text: 'Try again with ' },
      { text: seat.toUpperCase(), seat },
    ]);
  });

  it('names no seat when nothing says which one halted', () => {
    expect(recoveryActionLabel('switch-seat')).toBe('Change tool');
    expect(recoveryActionParts('switch-seat')).toEqual([{ text: 'Change tool' }]);
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

describe('recoveryActionLabel for a correction', () => {
  it.each([
    ['review-failed', 'Fix again'],
    ['plan-checks-failed', 'Send a correction'],
  ] as const)('names revise on a %s halt as %s', (reason, label) => {
    expect(recoveryActionLabel('revise', { reason })).toBe(label);
  });
});
