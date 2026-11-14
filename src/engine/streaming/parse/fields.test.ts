import { describe, expect, it } from 'vitest';
import { firstString } from './fields.js';

describe('firstString', () => {
  it('returns the first non-blank string, trimmed', () => {
    expect(firstString(undefined, 42, '   ', '  codex  ', 'later')).toBe('codex');
  });

  it('skips a blank or non-string value', () => {
    expect(firstString('', '  ', null, {}, 'x')).toBe('x');
  });

  it('returns undefined when no value is a non-blank string', () => {
    expect(firstString(undefined, '  ', 7)).toBeUndefined();
  });
});
