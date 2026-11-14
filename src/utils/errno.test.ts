import { describe, expect, it } from 'vitest';
import { hasErrnoCode, isENOENT } from './errno.js';

describe('isENOENT', () => {
  it('returns true for ENOENT errors', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    expect(isENOENT(err)).toBe(true);
  });

  it('returns false for other errors', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(isENOENT(err)).toBe(false);
  });

  it('returns false for non-Error objects', () => {
    expect(isENOENT('ENOENT')).toBe(false);
    expect(isENOENT(null)).toBe(false);
    expect(isENOENT(undefined)).toBe(false);
  });
});

describe('hasErrnoCode', () => {
  it('returns true for an Error with a listed code', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    expect(hasErrnoCode(err, 'EACCES', 'ENOENT')).toBe(true);
  });

  it('returns false for an Error with an unlisted code', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(hasErrnoCode(err, 'ENOENT', 'EEXIST')).toBe(false);
  });

  it('returns false for a plain object with code', () => {
    expect(hasErrnoCode({ code: 'ENOENT' }, 'ENOENT')).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(hasErrnoCode('ENOENT', 'ENOENT')).toBe(false);
    expect(hasErrnoCode(null, 'ENOENT')).toBe(false);
    expect(hasErrnoCode(undefined, 'ENOENT')).toBe(false);
  });
});
