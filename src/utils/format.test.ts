import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatCost, formatTime, formatTimeHHMMSS, formatDuration, toErrorMessage, formatRelativeTime, parseVersion } from './format.js';

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
});

describe('toErrorMessage', () => {
  it('extracts message from Error object', () => {
    expect(toErrorMessage(new Error('something broke'))).toBe('something broke');
  });

  it('converts string to string', () => {
    expect(toErrorMessage('plain string')).toBe('plain string');
  });

  it('converts unknown type to string representation', () => {
    expect(toErrorMessage(42)).toBe('42');
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });
});

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats recent time as just now', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(formatRelativeTime(now - 10_000)).toBe('just now');
  });

  it('formats minutes ago', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(formatRelativeTime(now - 5 * 60 * 1000)).toBe('5m ago');
  });

  it('formats hours ago', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(formatRelativeTime(now - 3 * 60 * 60 * 1000)).toBe('3h ago');
  });

  it('formats days ago', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60 * 1000)).toBe('2d ago');
  });
});

describe('parseVersion', () => {
  it('parses standard semver string', () => {
    expect(parseVersion('2.1.84')).toEqual([2, 1, 84]);
  });

  it('parses version with prefix text', () => {
    expect(parseVersion('codex-cli 0.111.0')).toEqual([0, 111, 0]);
  });

  it('parses version with v prefix', () => {
    expect(parseVersion('aider v0.82.1')).toEqual([0, 82, 1]);
  });

  it('parses version with suffix text', () => {
    expect(parseVersion('2.1.84 (Claude Code)')).toEqual([2, 1, 84]);
  });

  it('returns null for non-version string', () => {
    expect(parseVersion('no version here')).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(parseVersion('')).toBe(null);
  });

  it('returns null for partial version', () => {
    expect(parseVersion('1.2')).toBe(null);
  });

  it('parses version from multiline output', () => {
    expect(parseVersion('1.2.27\nsome other output')).toEqual([1, 2, 27]);
  });
});
