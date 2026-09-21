import { describe, expect, it } from 'vitest';
import { wrapHard } from '../../../../utils/wrap.js';
import { sanitizeRowDisplayText, wrappedProseTexts, wrappedRowTexts } from './text.js';

// The fast path skips wrap-ansi for a printable-ASCII line that already fits. It is only allowed to
// exist while it is indistinguishable from the wrapper, so the contract is asserted directly rather
// than by re-describing the wrapping rules.
function wrapperOutput(text: string, width: number): string[] {
  return wrapHard(sanitizeRowDisplayText(text), Math.max(1, width)).split('\n');
}

const SAMPLES = [
  '',
  ' ',
  'fits',
  '   leading and trailing   ',
  'x'.repeat(40),
  'x'.repeat(41),
  'x'.repeat(400),
  'a long line of prose that runs past the wrap width and has to break at a word boundary somewhere',
  'src/features/workflow/conversation-rows/row-format/text.ts:32:11 - error TS6133: declared but never read',
  'wide characters 日本語のテキスト stay off the fast path',
  '\u{1f389} emoji stays off the fast path',
  'combining á mark stays off the fast path',
  'two\nlines',
];

describe('wrappedRowTexts', () => {
  for (const width of [1, 5, 40, 78, 110]) {
    it(`matches the wrapper at width ${width}`, () => {
      for (const sample of SAMPLES) {
        expect(wrappedRowTexts(sample, width)).toEqual(wrapperOutput(sample, width));
      }
    });
  }

  it('returns a fitting ascii line untouched as a single row', () => {
    expect(wrappedRowTexts('npm run typecheck', 40)).toEqual(['npm run typecheck']);
  });

  it('still wraps an ascii line that exceeds the width', () => {
    expect(wrappedRowTexts('aaaa bbbb cccc', 9)).toEqual(['aaaa bbbb', ' cccc']);
  });

  it('sanitizes before deciding whether the line fits', () => {
    expect(wrappedRowTexts('\u001b[31mred\u001b[0m', 5)).toEqual(['red']);
  });
});

describe('wrappedProseTexts', () => {
  it('drops the break space a continuation would otherwise open with', () => {
    // The word before the break fills the row exactly, so the wrapper hands the space to the next
    // row; prose starts that row on its own column instead.
    expect(wrappedRowTexts('aaaa bbbb cccc', 9)).toEqual(['aaaa bbbb', ' cccc']);
    expect(wrappedProseTexts('aaaa bbbb cccc', 9)).toEqual(['aaaa bbbb', 'cccc']);
  });

  it('leaves the first row and a trailing break space as the wrapper wrote them', () => {
    expect(wrappedProseTexts('  indented', 20)).toEqual(['  indented']);
    expect(wrappedProseTexts('aaaa bbbb cccc', 10)).toEqual(wrappedRowTexts('aaaa bbbb cccc', 10));
  });
});
