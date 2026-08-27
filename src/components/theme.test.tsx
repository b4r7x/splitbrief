import { describe, it, expect } from 'vitest';
import type { Theme } from './theme.js';
import {
  ansiTerminalTheme,
  getTheme,
  resolveTheme,
  supportsHexColors,
  terminalTheme,
} from './theme.js';

// Every palette the app can hand out: terminalTheme plus the named-ANSI fallback resolveTheme
// substitutes when the terminal cannot render hex.
const PALETTES = [terminalTheme, ansiTerminalTheme];

const isString = (value: unknown): value is string => typeof value === 'string';

// Walked, never listed: every value the palette spends apart from the reviewer seat itself,
// so a token added later cannot fall out of the comparison unnoticed.
const valuesOtherThanReviewer = (theme: Theme): string[] =>
  Object.entries(theme)
    .filter(([token]) => token !== 'reviewer')
    .flatMap(([, value]) =>
      isString(value) ? [value] : Object.values(value ?? {}).filter(isString),
    );

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
  it.each([{ TERM: 'xterm' }, {}])('drops the hex code frame without hi-color support', (env) => {
    const resolved = resolveTheme(env);

    expect(resolved.markdown.codeBg).toBeUndefined();
    expect(resolved.markdown.codeGutter).toBe('gray');
    expect(resolved.markdown.heading).toBe(getTheme().markdown.heading);
  });

  it('keeps the hex code frame when the terminal advertises truecolor', () => {
    const resolved = resolveTheme({ COLORTERM: 'truecolor' });

    expect(resolved).toBe(getTheme());
    expect(resolved.markdown.codeBg).toBe('#24283b');
  });

  it('leaves cyan to paths and links in every preset it can hand out', () => {
    for (const theme of PALETTES) {
      expect(theme.markdown.heading).not.toBe(theme.markdown.link);
      expect(theme.markdown.list).not.toBe(theme.markdown.link);
      expect(theme.markdown.rule).not.toBe(theme.markdown.link);
    }
  });

  it('defines a reviewer hue in every palette', () => {
    for (const theme of PALETTES) {
      expect(theme.reviewer).toBeTruthy();
    }
  });

  it('gives the reviewer seat a value no other token in the same palette spends', () => {
    for (const theme of PALETTES) {
      expect(valuesOtherThanReviewer(theme)).not.toContain(theme.reviewer);
    }
  });
});
