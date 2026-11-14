import { describe, expect, it } from 'vitest';
import {
  padTerminalDisplayTextEnd,
  truncateByChars,
  truncateByTailLines,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
  truncateTerminalDisplayTextMiddleAtWords,
  truncateTerminalDisplayTextStart,
} from './truncate.js';
import { getTerminalCellWidth, splitTerminalGraphemes } from './width.js';

describe('truncateTerminalDisplayText', () => {
  it('sanitizes before truncating by terminal cell width', () => {
    expect(truncateTerminalDisplayText('\u001b[31m界語abc\u001b[0m', 5)).toBe('界語…');
  });

  it('preserves combining marks and emoji while fitting the requested width', () => {
    expect(truncateTerminalDisplayText('e\u0301e\u0301🙂z', 4)).toBe('e\u0301e\u0301…');
  });

  it('truncates emoji-presentation graphemes by their displayed cell width', () => {
    expect(truncateTerminalDisplayText('ab❤️cd', 5)).toBe('ab❤️…');
  });

  it('cuts a Thai text at the cells it paints', () => {
    expect(truncateTerminalDisplayText('ที่ใช้อยู่', 5)).toBe('ที่ใช้อยู่');
  });

  it('returns the original string when it fits the cell budget', () => {
    expect(truncateTerminalDisplayText('hello', 5)).toBe('hello');
  });

  it('keeps the result within the budget when glyphs are double width', () => {
    expect(truncateTerminalDisplayText('漢字語', 5)).toBe('漢字…');
  });

  it('returns an empty string when the budget is zero or negative', () => {
    expect(truncateTerminalDisplayText('abc', 0)).toBe('');
    expect(truncateTerminalDisplayText('abc', -2)).toBe('');
  });
});

describe('truncateTerminalDisplayTextStart', () => {
  it('sanitizes before preserving the tail by terminal cell width', () => {
    expect(truncateTerminalDisplayTextStart('\u001b]52;c;secret\u0007src/界語/path.ts', 12)).toBe(
      '…語/path.ts',
    );
  });

  it('does not split combining marks or emoji grapheme clusters', () => {
    expect(truncateTerminalDisplayTextStart('src/feature/e\u0301/👩‍💻-file.ts', 12)).toBe(
      '…/👩‍💻-file.ts',
    );
  });
});

describe('truncateTerminalDisplayTextMiddle', () => {
  it('preserves the head and tail by terminal cell width', () => {
    const result = truncateTerminalDisplayTextMiddle(
      "sed -n '1,260p' /Users/alice/.agents/library/codebase-exploration/SKILL.md",
      36,
    );

    expect(result.startsWith("sed -n '1,260p'")).toBe(true);
    expect(result.endsWith('SKILL.md')).toBe(true);
    expect(result).toContain('…');
    expect(getTerminalCellWidth(result)).toBeLessThanOrEqual(36);
  });

  it('does not split combining marks or emoji grapheme clusters', () => {
    const result = truncateTerminalDisplayTextMiddle('alpha/e\u0301/👩‍💻/omega.ts', 15);

    expect(result.startsWith('alpha/e\u0301')).toBe(true);
    expect(result.endsWith('mega.ts')).toBe(true);
    expect(result).toContain('…');
    expect(getTerminalCellWidth(result)).toBeLessThanOrEqual(15);
  });
});

describe('truncateTerminalDisplayTextMiddleAtWords', () => {
  it('strips controls and leaves fitting text unchanged', () => {
    const text = 'rg  --files 界👩‍💻';
    const width = getTerminalCellWidth(text);

    expect(truncateTerminalDisplayTextMiddleAtWords(text, width)).toBe(text);
    expect(truncateTerminalDisplayTextMiddleAtWords(`\u001b[31m${text}\u001b[0m`, width)).toBe(
      text,
    );
    expect(truncateTerminalDisplayTextMiddleAtWords(text, width + 1)).toBe(text);
  });

  it.each([
    ['abc def ghi jkl', 9, 'abc … jkl'],
    ['abc def ghi jkl', 10, 'abc … jkl'],
    ['abc  def ghi  jkl', 12, 'abc … jkl'],
    ['abc\u00a0def ghi\u2003jkl', 11, 'abc … jkl'],
  ])(
    'keeps complete tokens and budgets both ellipsis spaces: %s at %i',
    (text, budget, expected) => {
      expect(truncateTerminalDisplayTextMiddleAtWords(text, budget)).toBe(expected);
    },
  );

  it.each(['abcdefghijklmnop', 'abcdefghijklmnop end', 'run abcdefghijklmnop'])(
    'falls back to the plain middle cut when either side has no whole token: %s',
    (text) => {
      expect(truncateTerminalDisplayTextMiddleAtWords(text, 11)).toBe(
        truncateTerminalDisplayTextMiddle(text, 11),
      );
    },
  );

  it.each([
    [99, 'npm exec vitest run src/engine/calls/activity.test.ts … --reporter=verbose'],
    [
      100,
      'npm exec vitest run … src/features/workflow/display/activity-display-text.test.ts --reporter=verbose',
    ],
  ])('reuses the budget around long test paths at %i cells', (budget, expected) => {
    const text =
      'npm exec vitest run src/engine/calls/activity.test.ts src/features/workflow/display/activity-display-text.test.ts --reporter=verbose';
    const result = truncateTerminalDisplayTextMiddleAtWords(text, budget);

    expect(result).toBe(expected);
    expect(getTerminalCellWidth(result)).toBeLessThanOrEqual(budget);
  });

  it.each([
    ['aa bbbbbbb cc dddd ee', 16, 'aa bbbbbbb … ee'],
    ['aa bbbb cc ddddddd ee', 16, 'aa bbbb cc … ee'],
    ['  abc  def  ghi  jkl  ', 14, '  abc … jkl  '],
    [' aa  bb enormous cc\u00a0dd ', 16, ' aa  bb … cc\u00a0dd '],
  ])('packs whole tokens and preserves their original spacing: %s', (text, budget, expected) => {
    expect(truncateTerminalDisplayTextMiddleAtWords(text, budget)).toBe(expected);
  });

  it.each([
    "rg --files --hidden -g '!node_modules' -g '!.git' -g '!package-lock.json' -g '!yarn.lock' -g '!pnpm-lock.yaml'",
    'run 界語 👩‍💻 e\u0301cole ❤️ fin',
    '界語👩‍💻e\u0301❤️終',
  ])('fits every budget without splitting graphemes: %s', (text) => {
    const sourceGraphemes = splitTerminalGraphemes(text);
    for (let budget = 1; budget <= getTerminalCellWidth(text); budget += 1) {
      const result = truncateTerminalDisplayTextMiddleAtWords(text, budget);

      expect(getTerminalCellWidth(result), `budget ${budget}`).toBeLessThanOrEqual(budget);
      for (const grapheme of splitTerminalGraphemes(result)) {
        expect([...sourceGraphemes, '…'], `budget ${budget}`).toContain(grapheme);
      }
    }
    expect(truncateTerminalDisplayTextMiddleAtWords(text, 0)).toBe('');
    expect(truncateTerminalDisplayTextMiddleAtWords(text, -1)).toBe('');
  });

  it.each([
    [17, '界語 … e\u0301cole ❤️'],
    [18, '界語 👩‍💻 … e\u0301cole ❤️'],
  ])('keeps whole CJK and emoji tokens at the cut at %i cells', (budget, expected) => {
    expect(truncateTerminalDisplayTextMiddleAtWords('界語 👩‍💻 middle e\u0301cole ❤️', budget)).toBe(
      expected,
    );
  });
});

describe('padTerminalDisplayTextEnd', () => {
  it('pads by cells after sanitizing display text', () => {
    expect(padTerminalDisplayTextEnd('\u001b[31m界e\u0301', 4)).toBe('界e\u0301 ');
  });

  it('pads emoji-presentation graphemes by their displayed cell width', () => {
    expect(padTerminalDisplayTextEnd('©️', 4)).toBe('©️  ');
  });
});

describe('truncateByChars', () => {
  it('returns the original string when within the limit', () => {
    expect(truncateByChars('hello', 5)).toBe('hello');
    expect(truncateByChars('hi', 10)).toBe('hi');
  });

  it('fits the result within maxChars when truncating', () => {
    const result = truncateByChars('abcdefghij', 5);
    expect(result.length).toBe(5);
    expect(result).toBe('abcd…');
  });

  it('spends one of the maxChars on the ellipsis', () => {
    expect(truncateByChars('the quick brown fox', 8)).toBe('the qui…');
  });

  it('returns an empty string when maxChars is zero or negative', () => {
    expect(truncateByChars('abc', 0)).toBe('');
    expect(truncateByChars('abc', -3)).toBe('');
  });
});

describe('truncateByTailLines', () => {
  it('keeps the trailing lines when over the limit', () => {
    expect(truncateByTailLines('a\nb\nc', 2)).toBe('b\nc');
  });
});
