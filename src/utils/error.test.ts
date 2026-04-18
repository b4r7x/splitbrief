import { describe, expect, test } from 'vitest';
import { error, matches } from './error.js';

describe('error()', () => {
  test('creates an Error with kind, message, and data', () => {
    const e = error('command-not-found', 'git missing', { command: 'git' });
    expect(e).toBeInstanceOf(Error);
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

  test('leaves cause undefined when not provided', () => {
    const e = error('no-cause', 'msg', { x: 1 });
    expect(e.cause).toBeUndefined();
  });

  test('preserves kind on JSON round-trip of plain payload', () => {
    const e = error('serializable', 'msg', { id: 42 });
    const payload = { kind: e.kind, message: e.message, data: e.data };
    const roundTrip = JSON.parse(JSON.stringify(payload));
    expect(roundTrip).toEqual({ kind: 'serializable', message: 'msg', data: { id: 42 } });
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
    expect(isX(null)).toBe(false);
    expect(isX(undefined)).toBe(false);
    expect(isX('x')).toBe(false);
    expect(isX({ kind: 'x' })).toBe(false);
  });

  test('returns false for Error without a kind field', () => {
    const isX = matches('x');
    expect(isX(new Error('plain'))).toBe(false);
  });

  test('narrows type after predicate', () => {
    const isNotFound = matches('command-not-found');
    const e: unknown = error('command-not-found', 'git missing', { command: 'git' });
    if (isNotFound(e)) {
      expect(e.data).toEqual({ command: 'git' });
    } else {
      throw new Error('predicate should match');
    }
  });
});
