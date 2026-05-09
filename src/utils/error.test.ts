import { describe, expect, test } from 'vitest';
import { error, matches } from './error.js';

describe('error()', () => {
  test('creates an Error with kind, message, and data', () => {
    const e = error('command-not-found', 'git missing', { command: 'git' });
    expect(e.message).toBe('git missing');
    expect(e.kind).toBe('command-not-found');
    expect(e.data).toEqual({ command: 'git' });
  });

  test('omits data when not provided', () => {
    const e = error('bare-kind', 'no data');
    expect(e.data).toBeUndefined();
  });

  test('chains cause when provided', () => {
    const inner = new Error('inner');
    const e = error('wrap', 'outer', { x: 1 }, inner);
    expect(e.cause).toBe(inner);
  });
});

describe('matches()', () => {
  test('returns a predicate that identifies the matching kind', () => {
    const isTimeout = matches('command-timeout');
    expect(isTimeout(error('command-timeout', 'slow'))).toBe(true);
    expect(isTimeout(error('command-not-found', 'missing'))).toBe(false);
  });

  test('returns false for non-Error values', () => {
    const isX = matches('x');
    for (const value of [null, undefined, 'x', { kind: 'x' }]) {
      expect(isX(value)).toBe(false);
    }
  });

  test('returns false for Error without a kind field', () => {
    const isX = matches('x');
    expect(isX(new Error('plain'))).toBe(false);
  });
});
