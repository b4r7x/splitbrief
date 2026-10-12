import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS,
  getTerminalCellWidth,
  iterateTerminalGraphemes,
  normalizeDisplayLabel,
  padTerminalDisplayTextEnd,
  sanitizeTerminalDisplayText,
  segmentsForRowText,
  sanitizeTerminalDiagnosticText,
  splitTerminalGraphemes,
  stripTerminalControls,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
  truncateTerminalDisplayTextMiddleAtWords,
  truncateTerminalDisplayTextStart,
  wrapTerminalGraphemes,
} from './display-text.js';

describe('segmentsForRowText', () => {
  it('keeps the metadata of a truncated segment and its ellipsis', () => {
    const segments = [
      { text: 'Review', color: 'seat' },
      { text: ' T001', color: 'dim' },
      { text: ' passed', color: 'success' },
    ];
    expect(segmentsForRowText(segments, 'Revie…')).toEqual([{ text: 'Revie…', color: 'seat' }]);
    expect(segmentsForRowText(segments, 'Review T001 pa…')).toEqual([
      { text: 'Review', color: 'seat' },
      { text: ' T001', color: 'dim' },
      { text: ' pa…', color: 'success' },
    ]);
  });

  it('keeps Unicode spans intact when a continuation starts inside a segment', () => {
    expect(
      segmentsForRowText(
        [
          { text: 'Plan ', color: 'seat' },
          { text: '界👩‍💻 continue', color: 'text' },
        ],
        '👩‍💻 continue',
        'Plan 界'.length,
      ),
    ).toEqual([{ text: '👩‍💻 continue', color: 'text' }]);
  });
});

describe('stripTerminalControls', () => {
  it('removes ESC, BEL, OSC, CSI, and C0/C1 controls from display text', () => {
    const text = 'a\u001b[31mb\u001b[0mc\u0007d\u001b]0;owned\u0007e\u009b2Kf\u009dtitle\u009cg\nh';

    expect(stripTerminalControls(text)).toBe('abcdefgh');
  });
});

describe('sanitizeTerminalDisplayText', () => {
  it('preserves line breaks for prompt and markdown display text', () => {
    const text =
      'first\u001b[31m line\u001b[0m\nTOKEN=abcdefghijklmnopqrstuvwxyz1234567890abcdef\nlast';

    expect(sanitizeTerminalDisplayText(text, { preserveLineBreaks: true })).toBe(
      'first line\nTOKEN=***REDACTED***\nlast',
    );
  });
});

describe('normalizeDisplayLabel', () => {
  it('drops format characters and doubled spaces cursor-agent 2026.09.18 prints in a name', () => {
    expect(normalizeDisplayLabel('Grok 4.7  Low Fast\u200b\u200b')).toBe('Grok 4.7 Low Fast');
  });

  it('drops every Cf character, not only the zero-width space', () => {
    expect(normalizeDisplayLabel('\ufeffGPT\u00ad-5\u2060.5\u202e \u001b[2m1M\u001b[22m')).toBe(
      'GPT-5.5 1M',
    );
  });
});

describe('sanitizeTerminalDiagnosticText', () => {
  it('strips terminal controls, redacts secrets, and bounds diagnostic text', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = sanitizeTerminalDiagnosticText(
      `a \u001b]0;owned\u0007${jwt} ${'x'.repeat(20)}`,
      { maxChars: 20 },
    );

    expect(result).toBe('a ***REDACTED*** xx…');
  });

  it('uses the default terminal diagnostic bound', () => {
    const result = sanitizeTerminalDiagnosticText(
      'x'.repeat(DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS + 10),
    );

    expect(result).toHaveLength(DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('getTerminalCellWidth', () => {
  it('counts CJK and other wide glyphs as two cells', () => {
    expect(getTerminalCellWidth('abc界語')).toBe(7);
  });

  it('does not count combining marks as additional cells', () => {
    expect(getTerminalCellWidth('e\u0301cole')).toBe(5);
  });

  it('counts emoji grapheme clusters as two cells', () => {
    expect(getTerminalCellWidth('a👩‍💻🙂b')).toBe(6);
  });

  it.each([
    ['heart', '❤️'],
    ['keycap digit', '1️⃣'],
    ['gear', '⚙️'],
    ['copyright', '©️'],
    ['trademark', '™️'],
  ])('counts emoji-presentation %s as two cells', (_, grapheme) => {
    expect(getTerminalCellWidth(grapheme)).toBe(2);
  });

  it('keeps text-presentation symbols at one cell', () => {
    expect(getTerminalCellWidth('❤1⚙©™')).toBe(5);
  });

  it('measures every printable ASCII character as exactly one cell', () => {
    for (let codePoint = 0x20; codePoint <= 0x7e; codePoint += 1) {
      const char = String.fromCodePoint(codePoint);

      expect(getTerminalCellWidth(char)).toBe(1);
    }
  });

  it.each([
    ['unit separator', '\u001f'],
    ['delete', '\u007f'],
    ['tab', '\u0009'],
    ['line feed', '\n'],
    ['C1 control', '\u0085'],
  ])('still strips %s rather than measuring it as printable', (_, control) => {
    expect(getTerminalCellWidth(control)).toBe(0);
    expect(getTerminalCellWidth(`ab${control}cd`)).toBe(4);
  });

  it('measures an empty string as zero cells', () => {
    expect(getTerminalCellWidth('')).toBe(0);
  });
});

describe('splitTerminalGraphemes', () => {
  it('splits printable ASCII into one grapheme per character', () => {
    expect(splitTerminalGraphemes('a b~!')).toEqual(['a', ' ', 'b', '~', '!']);
  });

  it('keeps grapheme clusters intact and drops controls', () => {
    expect(splitTerminalGraphemes('a\u001b[31me\u0301\u{1f469}\u200d\u{1f4bb}')).toEqual([
      'a',
      'e\u0301',
      '\u{1f469}\u200d\u{1f4bb}',
    ]);
  });
});

describe('iterateTerminalGraphemes', () => {
  it('preserves line breaks on demand without splitting grapheme clusters', () => {
    expect(
      Array.from(iterateTerminalGraphemes('e\u0301\n👩‍💻', { preserveLineBreaks: true })),
    ).toEqual(['e\u0301', '\n', '👩‍💻']);
  });
});

describe('wrapTerminalGraphemes', () => {
  function wrappedLines(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    let current = '';

    wrapTerminalGraphemes({
      graphemes: iterateTerminalGraphemes(text),
      maxWidth,
      flush: () => {
        lines.push(current);
        current = '';
      },
      append: (grapheme) => {
        current += grapheme;
      },
    });

    lines.push(current);
    return lines;
  }

  it('keeps zero-width combining marks on the grapheme line', () => {
    expect(wrappedLines('e\u0301x', 1)).toEqual(['e\u0301', 'x']);
  });

  it('rolls a wide CJK grapheme at the cell boundary', () => {
    expect(wrappedLines('界a', 2)).toEqual(['界', 'a']);
  });

  it('keeps a ZWJ emoji grapheme whole', () => {
    expect(wrappedLines('👩‍💻x', 2)).toEqual(['👩‍💻', 'x']);
  });

  it('flushes only after an exact boundary is filled', () => {
    expect(wrappedLines('abcd', 2)).toEqual(['ab', 'cd']);
  });

  it('accepts a caller-owned prefix width before the boundary', () => {
    const lines: string[] = [];
    let current = 'prefix';

    wrapTerminalGraphemes({
      graphemes: ['x'],
      maxWidth: 6,
      initialWidth: 6,
      flush: () => {
        lines.push(current);
        current = '';
      },
      append: (grapheme) => {
        current += grapheme;
      },
    });
    lines.push(current);

    expect(lines).toEqual(['prefix', 'x']);
  });
});

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
