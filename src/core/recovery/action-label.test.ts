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
