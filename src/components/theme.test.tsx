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
  // chalk downsamples a hex to the 16-color set through ansi-styles rgbToAnsi: the themed
  // code ground #24283b lands on bgBlack, which is the terminal's own ground on a dark
  // profile, and the rail #6272a4 lands on blue, the bucket syntax.function already holds.
  // Neither survives, so a terminal without hex support is handed a preset that frames code
  // with the rail alone.
  it.each([
    ['mono' as const, { TERM: 'xterm' }],
    ['terminal' as const, { TERM: 'xterm' }],
    ['terminal' as const, {}],
  ])('drops the hex code frame for %s mode without hi-color support', (mode, env) => {
    const resolved = resolveTheme(mode, env);

    expect(resolved.markdown.codeBg).toBeUndefined();
    expect(resolved.markdown.codeGutter).toBe('gray');
    expect(resolved.markdown.heading).toBe(getTheme('terminal').markdown.heading);
  });

  it('keeps the hex code frame for terminal mode when the terminal advertises truecolor', () => {
    const resolved = resolveTheme('terminal', { COLORTERM: 'truecolor' });

    expect(resolved).toBe(getTheme('terminal'));
    expect(resolved.markdown.codeBg).toBe('#24283b');
  });

  it('keeps the mono hex preset when the terminal advertises truecolor', () => {
    const resolved = resolveTheme('mono', { COLORTERM: 'truecolor' });
    expect(resolved).toEqual(getTheme('mono'));
    expect(resolved.accent).toBe('#7aa2f7');
  });

  it('leaves cyan to paths and links in every preset it can hand out', () => {
    for (const theme of [
      getTheme('terminal'),
      getTheme('mono'),
      resolveTheme('terminal', { TERM: 'xterm' }),
    ]) {
      expect(theme.markdown.heading).not.toBe(theme.markdown.link);
      expect(theme.markdown.list).not.toBe(theme.markdown.link);
      expect(theme.markdown.rule).not.toBe(theme.markdown.link);
    }
  });
});
