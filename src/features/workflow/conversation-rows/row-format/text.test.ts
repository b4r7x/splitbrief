import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../../../utils/display-text.js';
import { wrapHard } from '../../../../utils/wrap.js';
import {
  sanitizeRowDisplayText,
  separatedSpans,
  wrappedPrefixedRowTexts,
  wrappedProseTexts,
  wrappedProseSegments,
  wrappedRowTexts,
} from './text.js';

it('keeps concept separators dim without a React renderer', () => {
  expect(separatedSpans('Build · stopped · partial changes kept', 'warning')).toEqual([
    { text: 'Build', tone: 'warning' },
    { text: ' · ', tone: 'textDim' },
    { text: 'stopped', tone: 'warning' },
    { text: ' · ', tone: 'textDim' },
    { text: 'partial changes kept', tone: 'warning' },
  ]);
  expect(separatedSpans('', 'warning')).toEqual([]);
});

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

describe('wrappedPrefixedRowTexts', () => {
  const path = '/Users/me/notes/product-planning/archive/receiving-workflow/brief.md';

  it.each([
    {
      width: 60,
      prefix: 'You → ',
      text: `@${path}`,
      first: 'You → @/Users/me/notes/product-planning/archive/',
      last: 'receiving-workflow/brief.md',
    },
    {
      width: 80,
      prefix: 'You → ',
      text: `@${path}`,
      first: 'You → @/Users/me/notes/product-planning/archive/receiving-workflow/',
      last: 'brief.md',
    },
    { width: 120, prefix: 'You → ', text: `@${path}`, first: `You → @${path}`, last: undefined },
    {
      width: 60,
      prefix: 'text · ',
      text: path,
      first: 'text · /Users/me/notes/product-planning/archive/',
      last: 'receiving-workflow/brief.md',
    },
    {
      width: 80,
      prefix: 'text · ',
      text: path,
      first: 'text · /Users/me/notes/product-planning/archive/receiving-workflow/',
      last: 'brief.md',
    },
    { width: 120, prefix: 'text · ', text: path, first: `text · ${path}`, last: undefined },
  ])(
    'keeps path segments whole with $prefix at $width columns',
    ({ width, prefix, text, first, last }) => {
      const bodyWidth = width - (prefix === 'You → ' ? 8 : 7);
      const lines = wrappedPrefixedRowTexts(text, bodyWidth, prefix);

      expect(lines).toEqual(last === undefined ? [first] : [first, last]);
      expect(lines.join('')).toBe(`${prefix}${text}`);
      expect(lines.every((line) => getTerminalCellWidth(line) <= bodyWidth)).toBe(true);
    },
  );

  it('hard-wraps a path segment when no slash fits', () => {
    expect(wrappedPrefixedRowTexts('@abcdefghijk/brief.md', 10, 'You → ')).toEqual([
      'You → @abc',
      'defghijk/',
      'brief.md',
    ]);
  });

  it('uses the last slash in the remaining room even when the whole path fits a new row', () => {
    expect(wrappedPrefixedRowTexts('Use @/a/b/c.md', 16, 'You → ')).toEqual([
      'You → Use @/a/b/',
      'c.md',
    ]);
  });

  it('measures Unicode paths in terminal cells and sanitizes control sequences', () => {
    expect(wrappedPrefixedRowTexts('\u001b[31m@/界界/brief.md\u001b[0m', 14, 'You → ')).toEqual([
      'You → @/界界/',
      'brief.md',
    ]);
  });

  it('keeps ordinary prose wrapping when a slash-containing word fits', () => {
    const text =
      'What should be refactored? Give a file/module/feature name or area of the codebase.';

    expect(wrappedPrefixedRowTexts(text, 54, '')).toEqual(wrappedRowTexts(text, 54));
  });
});

describe('wrappedProseTexts', () => {
  it.each([1, 5, 9, 11, 60, 200])(
    'preserves tones and existing prose layout at width %i',
    (width) => {
      const segments = [
        { text: 'Reviewer', tone: 'reviewer' },
        { text: ' check V1 · npm test · ', tone: 'textDim' },
        { text: 'failed', tone: 'error' },
        { text: ' · 3.0s', tone: 'textDim' },
      ] as const;
      const lines = wrappedProseSegments(segments, width);
      expect(lines.map((line) => line.map((span) => span.text).join(''))).toEqual(
        wrappedProseTexts(segments.map((span) => span.text).join(''), width),
      );
      expect(
        lines
          .flat()
          .filter((span) => span.tone === 'reviewer')
          .map((span) => span.text)
          .join(''),
      ).toBe('Reviewer');
      expect(
        lines
          .flat()
          .filter((span) => span.tone === 'error')
          .map((span) => span.text)
          .join(''),
      ).toBe('failed');
    },
  );
  it('drops the break space a continuation would otherwise open with', () => {
    // The word before the break fills the row exactly, so the wrapper hands the space to the next
    // row; prose starts that row on its own column instead.
    expect(wrappedRowTexts('aaaa bbbb cccc', 9)).toEqual(['aaaa bbbb', ' cccc']);
    expect(wrappedProseTexts('aaaa bbbb cccc', 9)).toEqual(['aaaa bbbb', 'cccc']);
  });

  it('drops a separator at a soft wrap boundary', () => {
    for (const width of [9, 11, 12]) {
      const lines = wrappedProseTexts('aaa · bbb · ccc', width);

      expect(lines.map((line) => line.trim())).toEqual(['aaa · bbb', 'ccc']);
      expect(lines.every((line) => !line.trimEnd().endsWith(' ·'))).toBe(true);
      expect(lines.every((line) => getTerminalCellWidth(line) <= width)).toBe(true);
    }
  });

  it('keeps reviewer verdicts on their continuation', () => {
    const examples = [
      {
        width: 56,
        check: 'Reviewer check V3 · node --test test/member.test.js',
        verdict: 'passed · 0.1s',
      },
      {
        width: 76,
        check: 'Reviewer check V4 · node --test test/checkout.test.js test/returns.…',
        verdict: 'passed · 0.2s',
      },
    ];

    for (const { width, check, verdict } of examples) {
      const lines = wrappedProseTexts(`${check} · ${verdict}`, width);

      expect(lines.map((line) => line.trim())).toEqual([check, verdict]);
      expect(lines.every((line) => !line.trimEnd().endsWith(' ·'))).toBe(true);
      expect(lines.every((line) => getTerminalCellWidth(line) <= width)).toBe(true);
    }
  });

  it('preserves duration NBSPs when dropping a separator', () => {
    const row = 'Fix check V2 · npm run test-ci · your 2 failures gone · 3 others left · 3m 0s';

    const lines = wrappedProseTexts(row, 74);

    expect(lines).toEqual([
      'Fix check V2 · npm run test-ci · your 2 failures gone · 3 others left ',
      '3m 0s',
    ]);
    for (const line of lines) expect(line.trimEnd().endsWith('·')).toBe(false);
  });

  it('leaves the first row and a trailing break space as the wrapper wrote them', () => {
    expect(wrappedProseTexts('  indented', 20)).toEqual(['  indented']);
    expect(wrappedProseTexts('aaaa bbbb cccc', 10)).toEqual(wrappedRowTexts('aaaa bbbb cccc', 10));
  });

  it('keeps inline separators, source-line bullets and indentation', () => {
    expect(
      wrappedProseTexts('first\n· item\n · item\n  · indented\n  indented · detail\n', 30),
    ).toEqual(['first', '· item', ' · item', '  · indented', '  indented · detail', '']);
  });

  it('hard wraps an oversized token after a separator', () => {
    const lines = wrappedProseTexts('aaa · abcdefghijklmnop', 9);

    expect(lines.map((line) => line.trim())).toEqual(['aaa', 'abcdefg', 'hijklmnop']);
    expect(lines.every((line) => !line.trimEnd().endsWith(' ·'))).toBe(true);
    expect(lines.every((line) => getTerminalCellWidth(line) <= 9)).toBe(true);
  });
});
