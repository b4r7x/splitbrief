import { describe, it, expect } from 'vitest';
import {
  deleteWordBackward,
  deleteLineBackward,
  moveToLineStart,
  moveToLineEnd,
  findVisualLineStart,
  resolveEditAction,
  applyEditAction,
  navigateVertically,
} from './text-editing.js';

describe('deleteWordBackward', () => {
  it('deletes word at end of string', () => {
    expect(deleteWordBackward('hello world', 11)).toEqual({ value: 'hello ', cursor: 6 });
  });

  it('deletes partial word when cursor is mid-word', () => {
    expect(deleteWordBackward('hello world', 8)).toEqual({ value: 'hello rld', cursor: 6 });
  });

  it('skips trailing spaces then deletes word', () => {
    expect(deleteWordBackward('hello   ', 8)).toEqual({ value: '', cursor: 0 });
  });

  it('returns unchanged when cursor is 0', () => {
    expect(deleteWordBackward('hello', 0)).toEqual({ value: 'hello', cursor: 0 });
  });

  it('returns unchanged for empty string', () => {
    expect(deleteWordBackward('', 0)).toEqual({ value: '', cursor: 0 });
  });

  it('deletes single word entirely', () => {
    expect(deleteWordBackward('hello', 5)).toEqual({ value: '', cursor: 0 });
  });

  it('deletes word after newline', () => {
    expect(deleteWordBackward('line1\nword', 10)).toEqual({ value: 'line1\n', cursor: 6 });
  });
});

describe('deleteLineBackward', () => {
  it('deletes entire single line from end', () => {
    expect(deleteLineBackward('hello world', 11)).toEqual({ value: '', cursor: 0 });
  });

  it('deletes to start of current line in multiline', () => {
    expect(deleteLineBackward('line1\nline2', 11)).toEqual({ value: 'line1\n', cursor: 6 });
  });

  it('deletes one char backward when cursor is at line start', () => {
    expect(deleteLineBackward('line1\nline2', 6)).toEqual({ value: 'line1line2', cursor: 5 });
  });

  it('returns unchanged when cursor is 0', () => {
    expect(deleteLineBackward('hello', 0)).toEqual({ value: 'hello', cursor: 0 });
  });

  it('is true no-op only at position 0', () => {
    expect(deleteLineBackward('a', 0)).toEqual({ value: 'a', cursor: 0 });
  });

  it('deletes middle line content in three-line string', () => {
    expect(deleteLineBackward('a\nb\nc', 3)).toEqual({ value: 'a\n\nc', cursor: 2 });
  });
});

describe('moveToLineStart', () => {
  it('moves to start of single line', () => {
    expect(moveToLineStart('hello', 3)).toEqual({ value: 'hello', cursor: 0 });
  });

  it('moves to start of current line in multiline', () => {
    expect(moveToLineStart('line1\nline2', 9)).toEqual({ value: 'line1\nline2', cursor: 6 });
  });

  it('stays at 0 when already at start', () => {
    expect(moveToLineStart('hello', 0)).toEqual({ value: 'hello', cursor: 0 });
  });
});

describe('moveToLineEnd', () => {
  it('moves to end of single line', () => {
    expect(moveToLineEnd('hello', 2)).toEqual({ value: 'hello', cursor: 5 });
  });

  it('moves to newline in multiline', () => {
    expect(moveToLineEnd('line1\nline2', 2)).toEqual({ value: 'line1\nline2', cursor: 5 });
  });

  it('stays at end when already there', () => {
    expect(moveToLineEnd('hello', 5)).toEqual({ value: 'hello', cursor: 5 });
  });
});

describe('findVisualLineStart', () => {
  it('returns 0 for text within one visual line', () => {
    expect(findVisualLineStart('hello', 5, 80)).toBe(0);
  });

  it('returns visual line start for hard-wrapped text (no spaces)', () => {
    // No word boundaries → hard wrap at column 10
    expect(findVisualLineStart('abcdefghijklmno', 15, 10)).toBe(10);
  });

  it('wraps at word boundary matching Ink rendering with cursor space', () => {
    // "abc defg hijk" (cursor space at pos 8). Ink wraps at width 10:
    // "abc defg " (9 chars) | "hijk" — cursor is on the first visual line
    expect(findVisualLineStart('abc defghijk', 8, 10)).toBe(0);
  });

  it('handles NFC Polish text correctly', () => {
    const nfc = 'Zażółć gęślą jaźń test';
    expect(nfc).toBe(nfc.normalize('NFC'));
    const result = findVisualLineStart(nfc, nfc.length, 10);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(nfc.length);
  });
});

describe('deleteLineBackward with columns', () => {
  it('deletes to visual line start when text hard-wraps (no spaces)', () => {
    expect(deleteLineBackward('abcdefghijklmno', 15, 10)).toEqual({
      value: 'abcdefghij',
      cursor: 10,
    });
  });

  it('deletes entire text when on first visual line', () => {
    expect(deleteLineBackward('hello', 5, 80)).toEqual({
      value: '',
      cursor: 0,
    });
  });

  it('deletes one char at visual line boundary to keep making progress', () => {
    // "abcdefghij" + cursor space at end → Ink wraps to "abcdefghij" | " "
    // Cursor is at visual line start — delete one char backward to join lines
    expect(deleteLineBackward('abcdefghij', 10, 10)).toEqual({
      value: 'abcdefghi',
      cursor: 9,
    });
  });

  it('falls back to logical line without columns', () => {
    expect(deleteLineBackward('abcdefghijklmno', 15)).toEqual({
      value: '',
      cursor: 0,
    });
  });

  it('deletes to word-wrap boundary matching Ink rendering', () => {
    // "abc defghijk" at width 10 wraps as "abc " | "defghijk"
    // Ctrl+U at end (pos 12) should delete "defghijk" (positions 4-12)
    expect(deleteLineBackward('abc defghijk', 12, 10)).toEqual({
      value: 'abc ',
      cursor: 4,
    });
  });

  it('handles NFD text by normalizing before visual line calculation', () => {
    const nfd = 'abc defghijk'.normalize('NFD');
    const nfc = 'abc defghijk';
    const result = deleteLineBackward(nfd, nfd.length, 10);
    // NFD input is normalized to NFC, producing same result
    expect(result).toEqual(deleteLineBackward(nfc, nfc.length, 10));
  });
});

describe('resolveEditAction', () => {
  const noMods = { ctrl: false, meta: false, super: false, backspace: false, delete: false };

  it('returns delete-word-backward for Ctrl+W', () => {
    expect(resolveEditAction('w', { ...noMods, ctrl: true })).toBe('delete-word-backward');
  });

  it('returns delete-line-backward for Ctrl+U', () => {
    expect(resolveEditAction('u', { ...noMods, ctrl: true })).toBe('delete-line-backward');
  });

  it('returns move-line-start for Ctrl+A', () => {
    expect(resolveEditAction('a', { ...noMods, ctrl: true })).toBe('move-line-start');
  });

  it('returns null for no special combo', () => {
    expect(resolveEditAction('a', noMods)).toBeNull();
  });
});

describe('applyEditAction', () => {
  it('returns null for null action', () => {
    expect(applyEditAction(null, 'hello', 5)).toBeNull();
  });
});

describe('navigateVertically', () => {
  it('moves up from second line to first', () => {
    expect(navigateVertically('up', 'abc\ndef', 5)).toBe(1);
  });

  it('moves down from first line to second', () => {
    expect(navigateVertically('down', 'abc\ndef', 1)).toBe(5);
  });

  it('returns undefined when already on first line moving up', () => {
    expect(navigateVertically('up', 'abc\ndef', 2)).toBeUndefined();
  });

  it('returns undefined when already on last line moving down', () => {
    expect(navigateVertically('down', 'abc\ndef', 5)).toBeUndefined();
  });

  it('clamps column to shorter target line', () => {
    // cursor at col 5 of "abcdef", moving to "hi" (len 2) → clamps to col 2 → index 7+2=9
    expect(navigateVertically('down', 'abcdef\nhi', 5)).toBe(9);
  });

  it('handles single line', () => {
    expect(navigateVertically('up', 'hello', 3)).toBeUndefined();
    expect(navigateVertically('down', 'hello', 3)).toBeUndefined();
  });

  it('handles three lines navigating to middle', () => {
    expect(navigateVertically('down', 'aaa\nbbb\nccc', 1)).toBe(5);
    expect(navigateVertically('up', 'aaa\nbbb\nccc', 9)).toBe(5);
  });

  it('handles cursor at line boundary', () => {
    expect(navigateVertically('down', 'abc\ndef', 3)).toBe(7);
  });
});
