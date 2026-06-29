import { describe, it, expect } from 'vitest';
import { getTheme, resolveTheme, supportsHexColors } from './theme.js';

describe('supportsHexColors', () => {
  it('is off when NO_COLOR is set to any non-empty value', () => {
    expect(supportsHexColors({ NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe(false);
  });

  it('ignores an empty NO_COLOR', () => {
    expect(supportsHexColors({ NO_COLOR: '', COLORTERM: 'truecolor' })).toBe(true);
  });

  it('is on for truecolor and 24bit COLORTERM', () => {
    expect(supportsHexColors({ COLORTERM: 'truecolor' })).toBe(true);
    expect(supportsHexColors({ COLORTERM: '24bit' })).toBe(true);
  });

  it('is on for a 256-color TERM', () => {
    expect(supportsHexColors({ TERM: 'xterm-256color' })).toBe(true);
  });

  it('is off for a bare 16-color terminal', () => {
    expect(supportsHexColors({ TERM: 'xterm' })).toBe(false);
    expect(supportsHexColors({})).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('falls back to the named-ANSI preset when mono is requested without hi-color support', () => {
    const resolved = resolveTheme('mono', { TERM: 'xterm' });
    expect(resolved).toBe(getTheme('terminal'));
  });

  it('keeps the mono hex preset when the terminal advertises truecolor', () => {
    const resolved = resolveTheme('mono', { COLORTERM: 'truecolor' });
    expect(resolved).toBe(getTheme('mono'));
    expect(resolved.accent).toBe('#7aa2f7');
  });

  it('always returns the named-ANSI preset for terminal mode', () => {
    expect(resolveTheme('terminal', {})).toBe(getTheme('terminal'));
  });
});
