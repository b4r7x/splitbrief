import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { contrastRatio, xterm256Hex } from '../../utils/color.js';
import {
  PALETTES,
  THEME_VARIANTS,
  themeTokenRole,
  type Theme,
  type ThemeColor,
  type ThemeVariant,
} from './palette.js';
import { pickThemeVariant, plainTheme, resolveTheme, themeForTerminal } from './resolve.js';

interface TerminalPalette {
  readonly name: string;
  readonly background: string;
  readonly foreground: string;
  readonly slots: readonly string[];
}

// Real terminal themes as Ghostty ships them. The 16-colour level paints the user's own palette
// slots, so its contrast can only be measured against palettes like these.
const TERMINAL_PALETTES: Readonly<Record<ThemeVariant, readonly TerminalPalette[]>> = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../testing/fixtures/terminal-palettes/ghostty-themes.json'),
    'utf8',
  ),
);

const ANSI_NAMES = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
] as const;

// Body and secondary text that carries no hue: the tokens the owner could not read.
const NEUTRAL_TEXT = [
  'text',
  'textDim',
  'info',
  'validator',
  'scrollIndicator',
  'diff.context',
  'markdown.heading',
  'markdown.bold',
  'markdown.italic',
  'markdown.blockquote',
  'markdown.list',
  'markdown.strike',
  'syntax.comment',
  'syntax.punctuation',
  'highlight.fg',
];

interface Leaf {
  readonly path: string;
  readonly color: ThemeColor;
}

function leaves(theme: Theme): Leaf[] {
  return Object.entries(theme).flatMap(([key, value]): Leaf[] =>
    typeof value === 'object' && value !== null
      ? Object.entries(value).map(([sub, color]): Leaf => {
          if (color !== undefined && typeof color !== 'string') {
            throw new Error(`Invalid theme color at ${key}.${sub}`);
          }
          return { path: `${key}.${sub}`, color };
        })
      : [{ path: key, color: value }],
  );
}

function colorAt(theme: Theme, path: string): ThemeColor {
  return leaves(theme).find((leaf) => leaf.path === path)?.color;
}

const ANSI_256 = /^ansi256\((\d+)\)$/;
const HEX = /^#[0-9a-f]{6}$/;

// What the terminal paints for a value the theme resolved at truecolor or 256 colours.
function paintedRgb(color: string): string {
  const indexed = ANSI_256.exec(color);
  return indexed ? xterm256Hex(Number(indexed[1])) : color;
}

function surfaces(theme: Theme): string[] {
  return leaves(theme).flatMap((leaf) =>
    themeTokenRole(leaf.path) === 'surface' && leaf.color !== undefined
      ? [paintedRgb(leaf.color)]
      : [],
  );
}

// Every text token against the terminal ground and every surface the theme paints; marks need 3:1,
// text 4.5:1; the cursor glyph only sits on the cursor block.
function contrastFailures(theme: Theme, ground: string): string[] {
  const grounds = [ground, ...surfaces(theme)];
  return leaves(theme).flatMap((leaf) => {
    const role = themeTokenRole(leaf.path);
    if (role === 'surface') return [];
    if (leaf.color === undefined) return [`${leaf.path}: no colour`];
    const cursorBlock = theme.cursor.bg;
    const against =
      role === 'cursor-text' && cursorBlock !== undefined ? [paintedRgb(cursorBlock)] : grounds;
    const min = role === 'mark' ? 3 : 4.5;
    const painted = paintedRgb(leaf.color);
    return against
      .filter((background) => contrastRatio(painted, background) < min)
      .map(
        (background) =>
          `${leaf.path} ${painted} on ${background}: ${contrastRatio(painted, background).toFixed(2)} < ${min}`,
      );
  });
}

describe('bundled themes reach the contrast at truecolor and 256 colours', () => {
  for (const variant of THEME_VARIANTS) {
    for (const level of [3, 2] as const) {
      it(`${variant} at level ${level} on its design ground and every surface`, () => {
        const theme = resolveTheme({ variant, level, terminalBackground: undefined });

        expect(contrastFailures(theme, PALETTES[variant].ground)).toEqual([]);
      });

      for (const palette of TERMINAL_PALETTES[variant]) {
        it(`${variant} at level ${level} on a detected ${palette.name} background`, () => {
          const theme = resolveTheme({ variant, level, terminalBackground: palette.background });

          expect(contrastFailures(theme, palette.background)).toEqual([]);
        });
      }
    }
  }

  // Grounds at the edge of each class: a mid-grey terminal still classifies as dark or light, and
  // the nearest readable value has to step further from the bundled one to reach the ratio.
  it.each([
    ['dark', '#000000'],
    ['dark', '#5c5c5c'],
    ['light', '#ffffff'],
    ['light', '#a8a8a8'],
  ] as const)('%s on the edge ground %s at both levels', (variant, ground) => {
    expect(pickThemeVariant({ background: ground, colorfgbg: undefined })).toBe(variant);
    for (const level of [3, 2] as const) {
      const theme = resolveTheme({ variant, level, terminalBackground: ground });

      expect(contrastFailures(theme, ground)).toEqual([]);
    }
  });
});

describe('one mapping from a token to what the terminal can show', () => {
  it('ships the bundled truecolor values unchanged when no background was detected', () => {
    for (const variant of THEME_VARIANTS) {
      const theme = resolveTheme({ variant, level: 3, terminalBackground: undefined });
      for (const leaf of leaves(theme)) {
        if (leaf.color === undefined) continue;
        expect(leaf.color, `${variant} ${leaf.path}`).toMatch(HEX);
      }
      expect(theme.textDim).toBe(PALETTES[variant].swatches.textDim.truecolor);
      expect(theme.text).toBe(PALETTES[variant].swatches.text.truecolor);
    }
  });

  it('spends only the fixed 256-colour cube and grey ramp at level 2, never the 16 palette slots', () => {
    for (const variant of THEME_VARIANTS) {
      const theme = resolveTheme({ variant, level: 2, terminalBackground: undefined });
      for (const leaf of leaves(theme)) {
        if (leaf.color === undefined) continue;
        const indexed = ANSI_256.exec(leaf.color);

        expect(indexed, `${variant} ${leaf.path} = ${leaf.color}`).not.toBeNull();
        expect(Number(indexed?.[1])).toBeGreaterThanOrEqual(16);
        expect(Number(indexed?.[1])).toBeLessThanOrEqual(255);
      }
    }
  });

  it("maps every token to the terminal's own ANSI colours at levels 1 and 0, never to a fixed RGB", () => {
    for (const variant of THEME_VARIANTS) {
      for (const level of [1, 0] as const) {
        const theme = resolveTheme({ variant, level, terminalBackground: '#24273a' });
        for (const leaf of leaves(theme)) {
          if (leaf.color === undefined) continue;

          expect(ANSI_NAMES, `${variant} ${leaf.path} = ${leaf.color}`).toContain(leaf.color);
        }
      }
    }
  });

  it("keeps neutral text readable at 16 colours in real palettes, or leaves it to the terminal's own foreground", () => {
    for (const variant of THEME_VARIANTS) {
      const theme = resolveTheme({ variant, level: 1, terminalBackground: undefined });
      for (const path of NEUTRAL_TEXT) {
        const color = colorAt(theme, path);
        if (color === undefined) continue;
        const slot = ANSI_NAMES.indexOf(color as (typeof ANSI_NAMES)[number]);
        for (const palette of TERMINAL_PALETTES[variant]) {
          const painted = palette.slots[slot] ?? '';

          expect(
            contrastRatio(painted, palette.background),
            `${variant} ${path} = ${color} on ${palette.name}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('returns the same theme object for the same inputs, so the context value stays stable', () => {
    const first = resolveTheme({ variant: 'dark', level: 2, terminalBackground: '#24273a' });

    expect(resolveTheme({ variant: 'dark', level: 2, terminalBackground: '#24273a' })).toBe(first);
    expect(resolveTheme({ variant: 'dark', level: 3, terminalBackground: '#24273a' })).not.toBe(
      first,
    );
  });

  it('leaves cyan to paths and links in every theme it can hand out', () => {
    for (const variant of THEME_VARIANTS) {
      for (const level of [3, 2, 1] as const) {
        const theme = resolveTheme({ variant, level, terminalBackground: undefined });

        expect(theme.markdown.heading).not.toBe(theme.markdown.link);
        expect(theme.markdown.list).not.toBe(theme.markdown.link);
        expect(theme.markdown.rule).not.toBe(theme.markdown.link);
      }
    }
  });

  it('gives the reviewer seat a value no other token in the same theme spends', () => {
    for (const variant of THEME_VARIANTS) {
      for (const level of [3, 2, 1] as const) {
        const theme = resolveTheme({ variant, level, terminalBackground: undefined });
        const others = leaves(theme)
          .filter((leaf) => leaf.path !== 'reviewer' && leaf.color !== undefined)
          .map((leaf) => leaf.color);

        expect(theme.reviewer, `${variant} level ${level}`).toBeDefined();
        expect(others, `${variant} level ${level}`).not.toContain(theme.reviewer);
      }
    }
  });
});

describe('plainTheme', () => {
  let originalLevel: typeof chalk.level;
  let originalColorfgbg: string | undefined;

  beforeEach(() => {
    originalLevel = chalk.level;
    originalColorfgbg = process.env.COLORFGBG;
    chalk.level = 3;
    delete process.env.COLORFGBG;
  });

  afterEach(() => {
    chalk.level = originalLevel;
    if (originalColorfgbg === undefined) delete process.env.COLORFGBG;
    else process.env.COLORFGBG = originalColorfgbg;
  });

  it('uses only terminal ANSI colours when the background is unknown', () => {
    for (const leaf of leaves(plainTheme())) {
      if (leaf.color === undefined) continue;
      expect(ANSI_NAMES, leaf.path).toContain(leaf.color);
    }
  });

  it('uses the light truecolor palette when COLORFGBG decides the background', () => {
    process.env.COLORFGBG = '0;15';
    expect(plainTheme()).toBe(
      resolveTheme({ variant: 'light', level: 3, terminalBackground: undefined }),
    );
  });

  it('preserves the truecolor dark fallback for the TUI', () => {
    expect(themeForTerminal(undefined)).toBe(
      resolveTheme({ variant: 'dark', level: 3, terminalBackground: undefined }),
    );
  });
});

describe('pickThemeVariant', () => {
  it('follows the detected background', () => {
    expect(pickThemeVariant({ background: '#24273a', colorfgbg: undefined })).toBe('dark');
    expect(pickThemeVariant({ background: '#eff1f5', colorfgbg: undefined })).toBe('light');
    expect(pickThemeVariant({ background: '#fdf6e3', colorfgbg: '15;0' })).toBe('light');
  });

  it.each([
    ['15;0', 'dark'],
    ['7;8', 'dark'],
    ['0;15', 'light'],
    ['0;7', 'light'],
    ['0;default;15', 'light'],
    ['12;4', 'dark'],
    ['nonsense', 'dark'],
  ] as const)('reads COLORFGBG %s as %s when no background was detected', (colorfgbg, variant) => {
    expect(pickThemeVariant({ background: undefined, colorfgbg })).toBe(variant);
  });

  it('falls back to dark when nothing is known', () => {
    expect(pickThemeVariant({ background: undefined, colorfgbg: undefined })).toBe('dark');
  });
});
