import { describe, it, expect } from 'vitest';
import {
  applyEditAction,
  dropLastCodePoint,
  navigateVertically,
  nextCodePointIndex,
  prevCodePointIndex,
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
    expect(prevCodePointIndex(`a${EMOJI}`, 3)).toBe(1);
    expect(nextCodePointIndex(EMOJI, 0)).toBe(2);
  });

  it('steps one unit for BMP text and clamps at the edges', () => {
    expect(prevCodePointIndex('ab', 2)).toBe(1);
    expect(prevCodePointIndex(EMOJI, 0)).toBe(0);
    expect(nextCodePointIndex('ab', 0)).toBe(1);
    expect(nextCodePointIndex(EMOJI, 2)).toBe(2);
  });

  it('drops the last whole code point', () => {
    const result = dropLastCodePoint(`hi${EMOJI}`);

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
