import { describe, expect, test } from 'vitest';
import { sessionError, sessionFileFailure } from './errors.js';

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

describe('sessionError.isStillActive', () => {
  test('matches stillActive factory output', () => {
    expect(sessionError.isStillActive(sessionError.stillActive('sess-1'))).toBe(true);
    expect(sessionError.isStillActive(sessionError.invalidData('id', 'why'))).toBe(false);
  });
});

describe('sessionFileFailure', () => {
  const nodeError = (code: string, words: string) =>
    Object.assign(new Error(`${code}: ${words}, open '/abs/project/.splitbrief/x'`), { code });

  test.each([
    ['EACCES', 'permission denied'],
    ['ENOSPC', 'no space left on device'],
    ['EROFS', 'read-only file system'],
  ])('spells %s as its words before the project-relative file', (code, words) => {
    expect(
      sessionFileFailure(
        'Could not save the run state',
        '.splitbrief/sessions/a/state.json',
        nodeError(code, words),
      ),
    ).toBe(`Could not save the run state: ${words} · .splitbrief/sessions/a/state.json`);
  });

  test('keeps the message of an error that is not a file error', () => {
    expect(sessionFileFailure('Draft not saved', 'f.json', new Error('outside the session'))).toBe(
      'Draft not saved: outside the session · f.json',
    );
  });
});
