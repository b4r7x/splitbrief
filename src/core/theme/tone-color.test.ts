import { describe, expect, it } from 'vitest';
import { defaultTheme } from '../../components/theme.js';
import { resolveTheme } from './resolve.js';
import { colorForTone } from './tone-color.js';

describe('the tone palette resolves to exactly the rendered colors', () => {
  const theme = defaultTheme;

  it.each(['dark', 'light'] as const)('maps explicit tones onto their %s colors', (variant) => {
    const resolved = resolveTheme({ variant, level: 3, terminalBackground: undefined });
    expect(colorForTone('text', resolved)).toBe(resolved.text);
    expect(colorForTone('textDim', resolved)).toBe(resolved.textDim);
    expect(colorForTone('success', resolved)).toBe(resolved.success);
    expect(colorForTone('error', resolved)).toBe(resolved.error);
  });

  it('requires a tone instead of inferring a primary colour', () => {
    expect(() => Reflect.apply(colorForTone, undefined, [undefined, theme])).toThrow(
      'Unexpected value: undefined',
    );
  });

  it.each(['dark', 'light'] as const)('maps the review seat to reviewer in %s', (variant) => {
    const resolved = resolveTheme({ variant, level: 3, terminalBackground: undefined });

    expect(colorForTone('reviewer', resolved)).toBe(resolved.reviewer);
  });

  it.each(['dark', 'light'] as const)(
    'maps closed-ledger links to markdown links in %s',
    (variant) => {
      const resolved = resolveTheme({ variant, level: 3, terminalBackground: undefined });

      expect(colorForTone('link', resolved)).toBe(resolved.markdown.link);
    },
  );

  it('maps markdown and syntax tones onto their theme tokens', () => {
    expect(colorForTone('markdownHeading', theme)).toBe(theme.markdown.heading);
    expect(colorForTone('markdownLink', theme)).toBe(theme.markdown.link);
    expect(colorForTone('markdownStrike', theme)).toBe(theme.markdown.strike);
    expect(colorForTone('markdownTableBorder', theme)).toBe(theme.markdown.tableBorder);
    expect(colorForTone('syntaxKeyword', theme)).toBe(theme.syntax.keyword);
    expect(colorForTone('syntaxString', theme)).toBe(theme.syntax.string);
    expect(colorForTone('syntaxComment', theme)).toBe(theme.syntax.comment);
    expect(colorForTone('syntaxNumber', theme)).toBe(theme.syntax.number);
    expect(colorForTone('syntaxLiteral', theme)).toBe(theme.syntax.literal);
    expect(colorForTone('syntaxType', theme)).toBe(theme.syntax.type);
    expect(colorForTone('syntaxFunction', theme)).toBe(theme.syntax.function);
    expect(colorForTone('syntaxPunctuation', theme)).toBe(theme.syntax.punctuation);
  });

  it('keeps dim metadata distinct from primary text and every state hue', () => {
    expect(colorForTone('textDim', theme)).not.toBe(colorForTone('text', theme));
    for (const hue of [theme.accent, theme.success, theme.error, theme.planner]) {
      expect(colorForTone('textDim', theme)).not.toBe(hue);
    }
  });
});
