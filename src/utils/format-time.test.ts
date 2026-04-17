import { describe, it, expect } from 'vitest';
import { formatTime, formatTimeHHMMSS, formatDuration, formatEta } from './format-time.js';

describe('formatDuration', () => {
  it('formats milliseconds to 1-decimal seconds', () => {
    expect(formatDuration(1500)).toBe('1.5s');
  });

  it('returns 0.0s for non-finite or negative input', () => {
    expect(formatDuration(NaN)).toBe('0.0s');
    expect(formatDuration(-3000)).toBe('0.0s');
  });
});

describe('formatTime', () => {
  it('formats hours, minutes, and seconds', () => {
    expect(formatTime(3665000)).toBe('1h 1m 5s');
  });

  it('omits hours when below one hour', () => {
    expect(formatTime(5000)).toBe('5s');
  });
});

describe('formatTimeHHMMSS', () => {
  it('formats zero-padded HH:MM:SS', () => {
    expect(formatTimeHHMMSS(3_665_000)).toBe('01:01:05');
  });
});

describe('formatEta', () => {
  it('formats remaining time with prefix', () => {
    expect(formatEta(45_000)).toBe('~45s remaining');
  });

  it('returns empty string when ms is zero or invalid', () => {
    expect(formatEta(0)).toBe('');
    expect(formatEta(-1000)).toBe('');
    expect(formatEta(NaN)).toBe('');
  });
});
