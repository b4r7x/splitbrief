import chalk from 'chalk';
import {
  nearestReadableIndex,
  readableHex,
  relativeLuminance,
  xterm256Hex,
} from '../../utils/color.js';
import { mapRecord } from '../../utils/type-guards.js';
import { PALETTES, themeTokenRole, type Swatch, type Theme, type ThemeVariant } from './palette.js';

export type ColorLevel = 0 | 1 | 2 | 3;

const candidates = Array.from({ length: 240 }, (_, index) => xterm256Hex(index + 16));
const resolvedThemes = new Map<string, Theme>();

function knownThemeVariant(input: {
  background: string | undefined;
  colorfgbg: string | undefined;
}): ThemeVariant | undefined {
  if (input.background !== undefined) {
    return relativeLuminance(input.background) < Math.sqrt(1.05 * 0.05) - 0.05 ? 'dark' : 'light';
  }
  const field = input.colorfgbg?.split(';').at(-1);
  if (field !== undefined && /^\d+$/.test(field)) {
    const index = Number(field);
    if (index <= 6 || index === 8) return 'dark';
    if (index === 7 || (index >= 9 && index <= 15)) return 'light';
  }
  return undefined;
}

export function pickThemeVariant(input: Parameters<typeof knownThemeVariant>[0]): ThemeVariant {
  return knownThemeVariant(input) ?? 'dark';
}

export function resolveTheme(input: {
  variant: ThemeVariant;
  level: ColorLevel;
  terminalBackground: string | undefined;
}): Theme {
  const { variant, level, terminalBackground } = input;
  const key = `${variant}|${level}|${terminalBackground ?? ''}`;
  const cached = resolvedThemes.get(key);
  if (cached) return cached;
  const palette = PALETTES[variant];
  const { diff, markdown, syntax, cursor, review, highlight, ...text } = palette.swatches;
  const surfaceHexes = [
    text.suggestionPanelBg,
    text.selectionBg,
    markdown.codeBg,
    highlight.bg,
  ].map((swatch) => swatch.truecolor);
  const ground = terminalBackground ?? palette.ground;
  const grounds = [
    ground,
    ...surfaceHexes.map((hex) =>
      level === 2 ? xterm256Hex(16 + nearestReadableIndex(hex, candidates, [], 0)) : hex,
    ),
  ];
  const indexed = (hex: string, against: readonly string[], min: number): number =>
    16 + nearestReadableIndex(hex, candidates, against, min);
  const cursorGrounds =
    level >= 2
      ? [
          level === 2
            ? xterm256Hex(indexed(cursor.bg.truecolor, grounds, 3))
            : readableHex(cursor.bg.truecolor, grounds, 3),
        ]
      : [];
  const resolveSwatch = (swatch: Swatch, path: string) => {
    if (level <= 1) return swatch.ansi;
    const role = themeTokenRole(path);
    const min = role === 'surface' ? 0 : role === 'mark' ? 3 : 4.5;
    const backgrounds = role === 'surface' ? [] : role === 'cursor-text' ? cursorGrounds : grounds;
    if (level === 2) {
      return `ansi256(${indexed(swatch.truecolor, backgrounds, min)})`;
    }
    return readableHex(swatch.truecolor, backgrounds, min);
  };
  const theme: Theme = Object.freeze({
    ...mapRecord(text, (swatch, leaf) => resolveSwatch(swatch, leaf)),
    diff: Object.freeze(mapRecord(diff, (swatch, leaf) => resolveSwatch(swatch, `diff.${leaf}`))),
    markdown: Object.freeze(
      mapRecord(markdown, (swatch, leaf) => resolveSwatch(swatch, `markdown.${leaf}`)),
    ),
    syntax: Object.freeze(
      mapRecord(syntax, (swatch, leaf) => resolveSwatch(swatch, `syntax.${leaf}`)),
    ),
    cursor: Object.freeze(
      mapRecord(cursor, (swatch, leaf) => resolveSwatch(swatch, `cursor.${leaf}`)),
    ),
    review: Object.freeze(
      mapRecord(review, (swatch, leaf) => resolveSwatch(swatch, `review.${leaf}`)),
    ),
    highlight: Object.freeze(
      mapRecord(highlight, (swatch, leaf) => resolveSwatch(swatch, `highlight.${leaf}`)),
    ),
  });
  resolvedThemes.set(key, theme);
  return theme;
}

export function themeForTerminal(terminalBackground: string | undefined): Theme {
  return resolveTheme({
    variant: pickThemeVariant({
      background: terminalBackground,
      colorfgbg: process.env.COLORFGBG,
    }),
    level: chalk.level,
    terminalBackground,
  });
}

export function plainTheme(): Theme {
  const variant = knownThemeVariant({
    background: undefined,
    colorfgbg: process.env.COLORFGBG,
  });
  return resolveTheme({
    variant: variant ?? 'dark',
    level: variant === undefined && chalk.level > 1 ? 1 : chalk.level,
    terminalBackground: undefined,
  });
}
