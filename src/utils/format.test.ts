import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatCost, formatTime, formatTimeHHMMSS, formatDuration, formatEta, toErrorMessage, formatRelativeTime, parseVersion, truncate, formatToolModel } from './format.js';

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

describe('formatToolModel', () => {
  it('returns empty string when both tool and model are undefined', () => {
    expect(formatToolModel(undefined, undefined)).toBe('');
  });

  it('returns empty string when both tool and model are empty strings', () => {
    expect(formatToolModel('', '')).toBe('');
  });

  it('returns display name + separator + model for known tool', () => {
    expect(formatToolModel('ollama', 'qwen2.5-coder:7b')).toBe('Ollama · qwen2.5-coder:7b');
  });

  it('passes through raw tool name + model for unknown tool', () => {
    expect(formatToolModel('my-provider', 'some-model')).toBe('my-provider · some-model');
  });

  it('returns just the display name when only tool is provided', () => {
    expect(formatToolModel('ollama')).toBe('Ollama');
  });

  it('returns just the model when only model is provided', () => {
    expect(formatToolModel(undefined, 'gpt-4o')).toBe('gpt-4o');
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

  it.each([NaN, Infinity, -Infinity])('returns just now for %s', (v) => {
    expect(formatRelativeTime(v)).toBe('just now');
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
