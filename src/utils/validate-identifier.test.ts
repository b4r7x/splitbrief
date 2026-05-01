import { describe, it, expect } from 'vitest';
import { validateSafeIdentifier } from './validate-identifier.js';

describe('validateSafeIdentifier', () => {
  it('accepts a plain identifier', () => {
    expect(validateSafeIdentifier('foo')).toEqual({ ok: true });
  });

  it('accepts an identifier with dashes and dots', () => {
    expect(validateSafeIdentifier('foo-bar.txt')).toEqual({ ok: true });
  });

  it('rejects an empty string', () => {
    const result = validateSafeIdentifier('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('must not be empty');
  });

  it('rejects whitespace-only input', () => {
    const result = validateSafeIdentifier('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('must not be empty');
  });

  it.each([
    ['..', 'path traversal'],
    ['foo..bar', 'embedded ..'],
    ['foo/bar', 'forward slash'],
    ['foo\\bar', 'backslash'],
  ])('rejects %s (%s)', (input) => {
    const result = validateSafeIdentifier(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("must not contain '..', '/' or '\\'");
  });
});
