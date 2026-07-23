import { describe, expect, it } from 'vitest';
import { getTheme } from '../../../components/theme.js';
import { colorForTone } from './tone-color.js';

describe('the tone palette resolves to exactly the rendered colors', () => {
  for (const mode of ['terminal', 'mono'] as const) {
    const theme = getTheme(mode);

    it(`maps every surviving tone onto its theme color in ${mode}`, () => {
      expect(colorForTone(undefined, theme)).toBe(theme.text);
      expect(colorForTone('text', theme)).toBe(theme.text);
      expect(colorForTone('textDim', theme)).toBe(theme.textDim);
      expect(colorForTone('success', theme)).toBe(theme.success);
      expect(colorForTone('error', theme)).toBe(theme.error);
    });

    it(`maps markdown and syntax tones onto their theme tokens in ${mode}`, () => {
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

    it(`keeps dim metadata distinct from primary text and every state hue in ${mode}`, () => {
      expect(colorForTone('textDim', theme)).not.toBe(colorForTone('text', theme));
      for (const hue of [theme.accent, theme.success, theme.error, theme.planner]) {
        expect(colorForTone('textDim', theme)).not.toBe(hue);
      }
    });
  }
});
