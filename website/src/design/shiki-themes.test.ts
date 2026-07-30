import { describe, expect, it } from 'vitest';
import { splitbriefDark, splitbriefDocsLight } from './shiki-themes.js';

const DARK_PALETTE = new Set([
  '#0B0B0D',
  '#141416',
  '#1E1E21',
  '#E8E6E1',
  '#A8A6A1',
  '#E85FA8',
  '#3FD2E0',
]);

const LIGHT_PALETTE = new Set([
  '#E8E6E1',
  '#DDDBD6',
  '#D2D0CB',
  '#1A1A1C',
  '#55554F',
  '#A01A67',
  '#0B5E66',
]);

const themeCases = [
  {
    theme: splitbriefDark,
    type: 'dark',
    palette: DARK_PALETTE,
    background: '#141416',
    foreground: '#E8E6E1',
    comment: '#A8A6A1',
    planner: '#E85FA8',
    implementer: '#3FD2E0',
  },
  {
    theme: splitbriefDocsLight,
    type: 'light',
    palette: LIGHT_PALETTE,
    background: '#DDDBD6',
    foreground: '#1A1A1C',
    comment: '#55554F',
    planner: '#A01A67',
    implementer: '#0B5E66',
  },
] as const;

describe('Splitbrief Shiki themes', () => {
  it('exports two distinct TextMate themes with explicit light and dark identities', () => {
    const names = themeCases.map(({ theme }) => theme.name);

    expect(new Set(names).size).toBe(themeCases.length);
    expect(names.every((name) => name.startsWith('splitbrief-'))).toBe(true);

    for (const { theme, type } of themeCases) {
      expect(theme.type).toBe(type);
      expect(theme.settings.length).toBeGreaterThan(1);
    }
  });

  it('uses only the corresponding site token palette', () => {
    for (const { theme, palette } of themeCases) {
      const colors = [
        ...Object.values(theme.colors),
        ...theme.settings.flatMap(({ settings }) =>
          [settings.foreground, settings.background].filter(
            (color): color is string => color !== undefined,
          ),
        ),
      ];

      expect(colors.every((color) => /^#[\dA-F]{6}$/.test(color))).toBe(true);
      expect(colors.every((color) => palette.has(color))).toBe(true);
    }
  });

  it('defines matching editor and fallback foreground and background colors', () => {
    for (const { theme, background, foreground } of themeCases) {
      expect(theme.colors).toMatchObject({
        'editor.background': background,
        'editor.foreground': foreground,
      });
      expect(theme.settings).toContainEqual({
        settings: { background, foreground },
      });
    }
  });

  it('covers comments, planner keys and keywords, and implementer values', () => {
    for (const { theme, comment, planner, implementer } of themeCases) {
      expect(theme.settings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scope: expect.arrayContaining(['comment']),
            settings: expect.objectContaining({ foreground: comment }),
          }),
          expect.objectContaining({
            scope: expect.arrayContaining(['keyword', 'entity.name.tag.yaml']),
            settings: expect.objectContaining({ foreground: planner }),
          }),
          expect.objectContaining({
            scope: expect.arrayContaining(['string', 'constant']),
            settings: expect.objectContaining({ foreground: implementer }),
          }),
        ]),
      );
    }
  });
});
