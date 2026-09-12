import { describe, expect, it } from 'vitest';
import { formatSeatResetNote } from './seat-reset.js';

function localTime(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('formatSeatResetNote', () => {
  it('says only the clock for a reset later today', () => {
    expect(formatSeatResetNote(localTime(2026, 7, 13, 17), localTime(2026, 7, 13, 9, 30))).toBe(
      'resets 17:00',
    );
  });

  it('pads a single-digit hour so the clock column never shifts', () => {
    expect(formatSeatResetNote(localTime(2026, 7, 13, 9, 5), localTime(2026, 7, 13, 8))).toBe(
      'resets 09:05',
    );
  });

  it('carries the date when the reset is not today', () => {
    expect(formatSeatResetNote(localTime(2026, 7, 14, 12), localTime(2026, 7, 13, 23))).toBe(
      'resets Jul 14, 12:00',
    );
  });
});
