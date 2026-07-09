import { describe, it, expect } from 'vitest';
import {
  applyEditAction,
  dropLastGrapheme,
  navigateVertically,
  nextGraphemeBoundary,
  prevGraphemeBoundary,
  resolveEditAction,
  type EditAction,
} from './text-editing.js';

const EMOJI = '😀';

function edit(action: NonNullable<EditAction>, value: string, cursor: number, columns?: number) {
  return applyEditAction({ action, value, cursor, columns });
}

describe('applyEditAction', () => {
  it('returns null for null action', () => {
    expect(applyEditAction({ action: null, value: 'hello', cursor: 5 })).toBeNull();
  });

  it.each([
    [
      'end of string',
      'delete-word-backward',
      'hello world',
      11,
      undefined,
      { value: 'hello ', cursor: 6 },
    ],
    [
      'mid-word',
      'delete-word-backward',
      'hello world',
      8,
      undefined,
      { value: 'hello rld', cursor: 6 },
    ],
    ['trailing spaces', 'delete-word-backward', 'hello   ', 8, undefined, { value: '', cursor: 0 }],
    [
      'after newline',
      'delete-word-backward',
      'line1\nword',
      10,
      undefined,
      { value: 'line1\n', cursor: 6 },
    ],
    [
      'line start',
      'move-line-start',
      'line1\nline2',
      9,
      undefined,
      { value: 'line1\nline2', cursor: 6 },
    ],
    [
      'line end',
      'move-line-end',
      'line1\nline2',
      2,
      undefined,
      { value: 'line1\nline2', cursor: 5 },
    ],
    [
      'delete forward',
      'delete-char-forward',
      `a${EMOJI}b`,
      1,
      undefined,
      { value: 'ab', cursor: 1 },
    ],
    [
      'move backward',
      'move-char-backward',
      `a${EMOJI}b`,
      4,
      undefined,
      { value: `a${EMOJI}b`, cursor: 3 },
    ],
    [
      'move forward',
      'move-char-forward',
      `a${EMOJI}b`,
      1,
      undefined,
      { value: `a${EMOJI}b`, cursor: 3 },
    ],
  ] as const)('%s', (_label, action, value, cursor, columns, expected) => {
    expect(edit(action, value, cursor, columns)).toEqual(expected);
  });

  it.each([
    ['single line', 'hello world', 11, undefined, { value: '', cursor: 0 }],
    ['multiline', 'line1\nline2', 11, undefined, { value: 'line1\n', cursor: 6 }],
    ['line boundary', 'line1\nline2', 6, undefined, { value: 'line1line2', cursor: 5 }],
    ['middle line', 'a\nb\nc', 3, undefined, { value: 'a\n\nc', cursor: 2 }],
    ['hard-wrap boundary', 'abcdefghijklmno', 15, 10, { value: 'abcdefghij', cursor: 10 }],
    ['first visual line', 'hello', 5, 80, { value: '', cursor: 0 }],
    ['visual boundary progress', 'abcdefghij', 10, 10, { value: 'abcdefghi', cursor: 9 }],
    ['word-wrap boundary', 'abc defghijk', 12, 10, { value: 'abc ', cursor: 4 }],
  ] as const)('delete-line-backward handles %s', (_label, value, cursor, columns, expected) => {
    expect(edit('delete-line-backward', value, cursor, columns)).toEqual(expected);
  });

  // findVisualLineStart must match Ink's wrap-ansi WORD-wrap render, NOT a grapheme
  // char-wrap. "abc defghijk" @10 renders as "abc " / "defghijk", so the 2nd visual
  // row starts at 4; a char-wrap (wrapVisualLines) would break at 10. These cases
  // fail if findVisualLineStart is re-pointed at wrapVisualLines (guards REQ-011).
  it.each([
    ['two-word wrap', 'abc defghijk', 12, 10, { value: 'abc defghijk', cursor: 4 }],
    ['long-word hard wrap', 'abcdefghijklmno', 15, 10, { value: 'abcdefghijklmno', cursor: 10 }],
    ['before wrap', 'abc defghijk', 3, 10, { value: 'abc defghijk', cursor: 0 }],
  ] as const)('move-line-start lands on the word-wrap row start (%s)', (_l, value, cursor, columns, expected) => {
    expect(edit('move-line-start', value, cursor, columns)).toEqual(expected);
  });

  it('normalizes decomposed text before visual line deletion', () => {
    const nfd = 'abc defghijk'.normalize('NFD');
    const nfc = 'abc defghijk';

    expect(edit('delete-line-backward', nfd, nfd.length, 10)).toEqual(
      edit('delete-line-backward', nfc, nfc.length, 10),
    );
  });

  it('does not split surrogate pairs when deleting around visual boundaries', () => {
    const result = edit('delete-line-backward', `a${EMOJI}`, 3, 2);

    expect(result?.value.normalize('NFC')).toBe(result?.value);
    expect(result?.value).not.toContain('\udc00');
  });
});

describe('composer regression (REQ-011)', () => {
  it.each([
    ['ascii delete backward', 'delete-char-backward', 'abc', 2, { value: 'ac', cursor: 1 }],
    ['ascii delete forward', 'delete-char-forward', 'abc', 0, { value: 'bc', cursor: 0 }],
    ['ascii move backward', 'move-char-backward', 'abc', 2, { value: 'abc', cursor: 1 }],
    ['ascii move forward', 'move-char-forward', 'abc', 0, { value: 'abc', cursor: 1 }],
    ['ascii delete word', 'delete-word-backward', 'foo bar', 7, { value: 'foo ', cursor: 4 }],
    ['ascii move line start', 'move-line-start', 'hello', 3, { value: 'hello', cursor: 0 }],
    ['ascii move line end', 'move-line-end', 'hello', 3, { value: 'hello', cursor: 5 }],
    [
      'surrogate delete backward stays whole',
      'delete-char-backward',
      `a${EMOJI}b`,
      3,
      { value: 'ab', cursor: 1 },
    ],
    [
      'surrogate delete forward stays whole',
      'delete-char-forward',
      `${EMOJI}b`,
      0,
      { value: 'b', cursor: 0 },
    ],
  ] as const)('applyEditAction preserves %s', (_label, action, value, cursor, expected) => {
    expect(edit(action, value, cursor)).toEqual(expected);
  });

  it.each([
    ['ascii down to middle line', 'down', 'aaa\nbbb\nccc', 1, 5],
    ['surrogate down keeps goal column', 'down', `a${EMOJI}\nbcd`, 3, 7],
    ['surrogate down clamps without splitting', 'down', `${EMOJI}\nx`, 2, 4],
    ['surrogate up keeps goal column', 'up', `bcd\na${EMOJI}`, 7, 3],
  ] as const)('navigateVertically preserves %s', (_label, direction, value, cursorIndex, expected) => {
    expect(navigateVertically({ direction, value, cursorIndex })).toBe(expected);
  });

  it('code-point helpers step whole surrogate pairs and ascii units', () => {
    expect(prevGraphemeBoundary(`a${EMOJI}`, 3)).toBe(1);
    expect(nextGraphemeBoundary(`a${EMOJI}`, 1)).toBe(3);
    expect(prevGraphemeBoundary('abc', 3)).toBe(2);
    expect(nextGraphemeBoundary('abc', 0)).toBe(1);
  });
});

describe('resolveEditAction', () => {
  const noMods = { ctrl: false, meta: false, super: false, backspace: false, delete: false };

  it.each([
    ['Ctrl+W', 'w', { ctrl: true }, 'delete-word-backward'],
    ['Ctrl+U', 'u', { ctrl: true }, 'delete-line-backward'],
    ['Ctrl+A', 'a', { ctrl: true }, 'move-line-start'],
    ['Ctrl+E', 'e', { ctrl: true }, 'move-line-end'],
    ['Ctrl+B', 'b', { ctrl: true }, 'move-char-backward'],
    ['Ctrl+F', 'f', { ctrl: true }, 'move-char-forward'],
    ['plain Backspace', '', { backspace: true }, 'delete-char-backward'],
    ['plain Delete', '', { delete: true }, 'delete-char-forward'],
    ['raw terminal DEL', '\x7f', {}, 'delete-char-backward'],
  ] as const)('%s resolves to %s', (_label, input, key, expected) => {
    expect(resolveEditAction(input, { ...noMods, ...key })).toBe(expected);
  });

  it('reserves modifier deletion chords for text editing', () => {
    expect(resolveEditAction('', { ...noMods, meta: true, backspace: true })).toBe(
      'delete-word-backward',
    );
    expect(resolveEditAction('', { ...noMods, ctrl: true, delete: true })).toBe(
      'delete-word-backward',
    );
    expect(resolveEditAction('', { ...noMods, super: true, delete: true })).toBe(
      'delete-line-backward',
    );
  });

  it('returns null for ordinary input', () => {
    expect(resolveEditAction('a', noMods)).toBeNull();
  });
});

describe('code-point helpers', () => {
  it('steps over surrogate pairs', () => {
    expect(prevGraphemeBoundary(`a${EMOJI}`, 3)).toBe(1);
    expect(nextGraphemeBoundary(EMOJI, 0)).toBe(2);
  });

  it('steps one unit for BMP text and clamps at the edges', () => {
    expect(prevGraphemeBoundary('ab', 2)).toBe(1);
    expect(prevGraphemeBoundary(EMOJI, 0)).toBe(0);
    expect(nextGraphemeBoundary('ab', 0)).toBe(1);
    expect(nextGraphemeBoundary(EMOJI, 2)).toBe(2);
  });

  it('drops the last whole code point', () => {
    const result = dropLastGrapheme(`hi${EMOJI}`);

    expect(result).toBe('hi');
    expect(result.normalize('NFC')).toBe(result);
  });
});

describe('navigateVertically', () => {
  it.each([
    ['up to first line', 'up', 'abc\ndef', 5, 1],
    ['down to second line', 'down', 'abc\ndef', 1, 5],
    ['down clamps to shorter line', 'down', 'abcdef\nhi', 5, 9],
    ['down from first boundary', 'down', 'abc\ndef', 3, 7],
    ['down to middle line', 'down', 'aaa\nbbb\nccc', 1, 5],
    ['up to middle line', 'up', 'aaa\nbbb\nccc', 9, 5],
  ] as const)('%s', (_label, direction, value, cursorIndex, expected) => {
    expect(navigateVertically({ direction, value, cursorIndex })).toBe(expected);
  });

  it.each([
    ['up at first line', 'up', 'abc\ndef', 2],
    ['down at last line', 'down', 'abc\ndef', 5],
    ['single line up', 'up', 'hello', 3],
    ['single line down', 'down', 'hello', 3],
  ] as const)('returns undefined for %s', (_label, direction, value, cursorIndex) => {
    expect(navigateVertically({ direction, value, cursorIndex })).toBeUndefined();
  });
});
