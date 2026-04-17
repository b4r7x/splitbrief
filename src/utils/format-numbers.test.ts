import { describe, it, expect } from 'vitest';
import { formatCost, formatTime, formatTimeHHMMSS, formatDuration, formatEta, truncate } from './format-numbers.js';

describe('formatCost', () => {
  it('formats zero as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('formats dollars with two decimal places', () => {
    expect(formatCost(42.5)).toBe('$42.50');
  });

  it('rounds sub-cent amounts to $0.00', () => {
    expect(formatCost(0.001)).toBe('$0.00');
  });

  it.each([NaN, Infinity, -Infinity])('returns $0.00 for %s', (v) => {
    expect(formatCost(v)).toBe('$0.00');
  });

  it('clamps negative values to $0.00', () => {
    expect(formatCost(-5.50)).toBe('$0.00');
  });
});

describe('formatTime', () => {
  it('formats seconds only', () => {
    expect(formatTime(5000)).toBe('5s');
  });

  it('formats minutes and seconds', () => {
    expect(formatTime(65000)).toBe('1m 5s');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatTime(3665000)).toBe('1h 1m 5s');
  });

  it('formats zero milliseconds', () => {
    expect(formatTime(0)).toBe('0s');
  });

  it.each([NaN, Infinity, -Infinity])('returns 0s for %s', (v) => {
    expect(formatTime(v)).toBe('0s');
  });

  it('clamps negative values to 0s', () => {
    expect(formatTime(-5000)).toBe('0s');
  });
});

describe('formatTimeHHMMSS', () => {
  it('formats zero', () => {
    expect(formatTimeHHMMSS(0)).toBe('00:00:00');
  });

  it('formats seconds only', () => {
    expect(formatTimeHHMMSS(5000)).toBe('00:00:05');
  });

  it('formats minutes and seconds', () => {
    expect(formatTimeHHMMSS(65_000)).toBe('00:01:05');
  });

  it('formats hours, minutes, and seconds', () => {
    expect(formatTimeHHMMSS(3_665_000)).toBe('01:01:05');
  });

  it('pads single digits', () => {
    expect(formatTimeHHMMSS(61_000)).toBe('00:01:01');
  });

  it('clamps negative values to zero', () => {
    expect(formatTimeHHMMSS(-5000)).toBe('00:00:00');
  });

  it.each([NaN, Infinity, -Infinity])('returns 00:00:00 for %s', (v) => {
    expect(formatTimeHHMMSS(v)).toBe('00:00:00');
  });
});

describe('formatDuration', () => {
  it('formats milliseconds to seconds', () => {
    expect(formatDuration(1500)).toBe('1.5s');
  });

  it('formats zero ms', () => {
    expect(formatDuration(0)).toBe('0.0s');
  });

  it('handles large values', () => {
    expect(formatDuration(120000)).toBe('120.0s');
  });

  it.each([NaN, Infinity, -Infinity])('returns 0.0s for %s', (v) => {
    expect(formatDuration(v)).toBe('0.0s');
  });

  it('clamps negative values to 0.0s', () => {
    expect(formatDuration(-3000)).toBe('0.0s');
  });
});

describe('formatEta', () => {
  it('returns empty string for zero ms', () => {
    expect(formatEta(0)).toBe('');
  });

  it('returns empty string for negative ms', () => {
    expect(formatEta(-1000)).toBe('');
  });

  it('formats seconds remaining', () => {
    expect(formatEta(45_000)).toBe('~45s remaining');
  });

  it('formats minutes remaining', () => {
    expect(formatEta(240_000)).toBe('~4m 0s remaining');
  });

  it.each([NaN, Infinity, -Infinity])('returns empty string for %s', (v) => {
    expect(formatEta(v)).toBe('');
  });
});

describe('truncate', () => {
  it('returns empty string for empty input', () => {
    expect(truncate('', 10)).toBe('');
  });

  it('returns original string when shorter than max', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns original string when equal to max', () => {
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates and adds ellipsis when longer than max', () => {
    expect(truncate('hello world', 5)).toBe('hell\u2026');
  });

  it('returns empty string for max=0', () => {
    expect(truncate('hello', 0)).toBe('');
  });

  it('returns empty string for max=1 with non-empty input', () => {
    expect(truncate('hi', 1)).toBe('\u2026');
  });

  it('truncates to single char + ellipsis for max=2', () => {
    expect(truncate('hello', 2)).toBe('h\u2026');
  });

  it('handles non-ASCII characters', () => {
    expect(truncate('café ☕ naïve', 6)).toBe('caf\u00e9 \u2026');
  });

  it('returns empty string for negative max', () => {
    expect(truncate('hello', -1)).toBe('');
  });
});
