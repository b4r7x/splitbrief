import { describe, expect, it } from 'vitest';
import { padTerminalDisplayTextEnd, truncateTerminalDisplayText } from './truncate.js';
import { segmentsForRowText } from './width.js';
import {
  getTerminalCellWidth,
  iterateTerminalGraphemes,
  splitTerminalGraphemes,
  wrapTerminalGraphemes,
} from './width.js';

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

describe('getTerminalCellWidth', () => {
  it('counts CJK and other wide glyphs as two cells', () => {
    expect(getTerminalCellWidth('abc界語')).toBe(7);
  });

  it('does not count combining marks as additional cells', () => {
    expect(getTerminalCellWidth('e\u0301cole')).toBe(5);
  });

  it.each([
    ['ที่ใช้อยู่', 5],
    ['You → ที่ใช้อยู่ it', 14],
    ['น้ำ', 2],
    ['กั', 1],
  ])('counts no cell for a Thai mark above or below a letter: %s', (text, cells) => {
    expect(getTerminalCellWidth(text)).toBe(cells);
  });

  it('counts one cell for the Thai vowel that stands after its letter', () => {
    expect(getTerminalCellWidth('กำ')).toBe(2);
    expect(getTerminalCellWidth('กา')).toBe(2);
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
    ['C1 control', '\u0085'],
  ])('still strips %s rather than measuring it as printable', (_, control) => {
    expect(getTerminalCellWidth(control)).toBe(0);
    expect(getTerminalCellWidth(`ab${control}cd`)).toBe(4);
  });

  it.each([
    ['tab', '\t'],
    ['line feed', '\n'],
    ['run of line breaks', '\r\n\n'],
  ])('measures a %s as the one space it shows as', (_, control) => {
    expect(getTerminalCellWidth(control)).toBe(1);
    expect(getTerminalCellWidth(`ab${control}cd`)).toBe(5);
  });

  it('truncates and pads text with a line break by the space it shows as', () => {
    expect(truncateTerminalDisplayText('alpha\nbeta', 8)).toBe('alpha b…');
    expect(truncateTerminalDisplayText('alpha\nbeta', 10)).toBe('alpha beta');
    expect(padTerminalDisplayTextEnd('a\tb', 5)).toBe('a b  ');
  });

  it('measures an empty string as zero cells', () => {
    expect(getTerminalCellWidth('')).toBe(0);
  });

  it('measures a cursor restore sequence as zero cells', () => {
    expect(getTerminalCellWidth('\u001b8')).toBe(0);
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
