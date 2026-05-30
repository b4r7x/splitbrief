import { describe, expect, test } from 'vitest';
import { sessionError } from './errors.js';

describe('sessionError factories', () => {
  test('invalidData carries sessionId + reason', () => {
    const err = sessionError.invalidData('2024-01-01-feature', 'status missing');
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('session-invalid-data');
    expect(err.message).toBe('Invalid session data: status missing');
    expect(err.data).toEqual({ sessionId: '2024-01-01-feature', reason: 'status missing' });
  });

  test('idCollision carries base and attempts', () => {
    const err = sessionError.idCollision('2024-01-01-auth', 100);
    expect(err.kind).toBe('session-id-collision');
    expect(err.message).toContain('2024-01-01-auth');
    expect(err.message).toContain('100');
    expect(err.data).toEqual({ base: '2024-01-01-auth', attempts: 100 });
  });
});

describe('sessionError predicates', () => {
  test('isInvalidData matches factory output', () => {
    expect(sessionError.isInvalidData(sessionError.invalidData('id', 'why'))).toBe(true);
    expect(sessionError.isInvalidData(sessionError.idCollision('base', 10))).toBe(false);
    expect(sessionError.isInvalidData(new Error('plain'))).toBe(false);
    expect(sessionError.isInvalidData(null)).toBe(false);
  });

  test('isIdCollision matches factory output', () => {
    expect(sessionError.isIdCollision(sessionError.idCollision('base', 10))).toBe(true);
    expect(sessionError.isIdCollision(sessionError.invalidData('id', 'r'))).toBe(false);
    expect(sessionError.isIdCollision(undefined)).toBe(false);
  });
});
