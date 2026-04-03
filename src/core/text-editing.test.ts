import { describe, it, expect } from 'vitest';
import {
  deleteWordBackward,
  deleteWordForward,
  deleteLineBackward,
  deleteLineForward,
  moveToLineStart,
  moveToLineEnd,
  findVisualLineStart,
  resolveEditAction,
  applyEditAction,
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

describe('deleteWordForward', () => {
  it('deletes word and trailing spaces at cursor start', () => {
    expect(deleteWordForward('hello world', 0)).toEqual({ value: 'world', cursor: 0 });
  });

  it('deletes word and trailing spaces', () => {
    expect(deleteWordForward('hello   world', 0)).toEqual({ value: 'world', cursor: 0 });
  });

  it('returns unchanged at end of string', () => {
    expect(deleteWordForward('hello', 5)).toEqual({ value: 'hello', cursor: 5 });
  });

  it('deletes rest of word and trailing spaces from mid-position', () => {
    expect(deleteWordForward('hello world', 3)).toEqual({ value: 'helworld', cursor: 3 });
  });

  it('stops at newline', () => {
    expect(deleteWordForward('hello\nworld', 0)).toEqual({ value: '\nworld', cursor: 0 });
  });

  it('returns unchanged for empty string', () => {
    expect(deleteWordForward('', 0)).toEqual({ value: '', cursor: 0 });
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

describe('deleteLineForward', () => {
  it('deletes to end of single line', () => {
    expect(deleteLineForward('hello world', 5)).toEqual({ value: 'hello', cursor: 5 });
  });

  it('deletes to newline in multiline', () => {
    expect(deleteLineForward('line1\nline2', 2)).toEqual({ value: 'li\nline2', cursor: 2 });
  });

  it('returns unchanged at end of string', () => {
    expect(deleteLineForward('hello', 5)).toEqual({ value: 'hello', cursor: 5 });
  });

  it('returns unchanged when cursor is at newline', () => {
    expect(deleteLineForward('line1\nline2', 5)).toEqual({ value: 'line1\nline2', cursor: 5 });
  });

  it('deletes from start of line', () => {
    expect(deleteLineForward('hello world', 0)).toEqual({ value: '', cursor: 0 });
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

  it('returns correct start for cursor mid-wrap (no spaces)', () => {
    expect(findVisualLineStart('abcdefghijklmno', 12, 10)).toBe(10);
  });

  it('respects logical line breaks', () => {
    expect(findVisualLineStart('abc\ndef', 6, 80)).toBe(4);
  });

  it('returns cursor position when text fills visual line and cursor space pushes to next', () => {
    // "abcdefghij" (10 chars) + cursor space at end = "abcdefghij " (11 chars)
    // Ink wraps to "abcdefghij" | " " — cursor is on the second (empty) visual line
    expect(findVisualLineStart('abcdefghij', 10, 10)).toBe(10);
  });

  it('handles multiple hard-wrap boundaries', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz1234';
    expect(findVisualLineStart(text, 25, 10)).toBe(20);
  });

  it('handles cursor at end of second visual line (cursor space pushes to third)', () => {
    // 20 chars at columns=10 + cursor space at end = 21 chars
    // Ink wraps to "abcdefghij" | "klmnopqrst" | " " — cursor is on the third visual line
    expect(findVisualLineStart('abcdefghijklmnopqrst', 20, 10)).toBe(20);
  });

  it('wraps at word boundary matching Ink rendering with cursor space', () => {
    // "abc defg hijk" (cursor space at pos 8). Ink wraps at width 10:
    // "abc defg " (9 chars) | "hijk" — cursor is on the first visual line
    expect(findVisualLineStart('abc defghijk', 8, 10)).toBe(0);
  });

  it('wraps realistic text at 74 columns (80-col terminal)', () => {
    const text = 'describe the feature that you want to implement in this project with full detail';
    expect(findVisualLineStart(text, text.length, 74)).toBe(74);
  });

  it('wraps realistic text at 114 columns (120-col terminal)', () => {
    const text = 'add user authentication using JWT tokens with refresh token support and implement the login page with proper validation and error handling for all edge cases';
    expect(findVisualLineStart(text, text.length, 114)).toBe(109);
  });

  it('cursor at boundary where cursor space pushes to next visual line', () => {
    // "hello wo rld" (cursor space at pos 8). Ink wraps at width 8:
    // "hello wo" (8 chars exactly) | " rld" — cursor is on the second visual line
    expect(findVisualLineStart('hello world', 8, 8)).toBe(8);
  });

  it('cursor at position 0 (cursor space is first character)', () => {
    // " abcdefghij" (cursor space at pos 0). Cursor is on the first visual line
    expect(findVisualLineStart('abcdefghij', 0, 10)).toBe(0);
  });

  it('cursor mid-line does not change visual line start', () => {
    // "abcde fghijklmno" (cursor space at pos 5). Wrapped at 10: "abcde fghi" | "jklmno"
    // Cursor at 5 is within the first visual line
    expect(findVisualLineStart('abcdefghijklmno', 5, 10)).toBe(0);
  });

  it('cursor at wrap boundary with room for cursor space stays on same line', () => {
    // "abcdefghi" (9 chars) + cursor space at end = "abcdefghi " (10 chars)
    // Fits in one line at width 10 — cursor stays on first visual line
    expect(findVisualLineStart('abcdefghi', 9, 10)).toBe(0);
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

  it('returns null for plain backspace', () => {
    expect(resolveEditAction('', { ...noMods, backspace: true })).toBeNull();
  });

  it('returns delete-word-backward for Meta+Backspace (Option+Backspace)', () => {
    expect(resolveEditAction('', { ...noMods, meta: true, backspace: true })).toBe('delete-word-backward');
  });

  it('returns delete-word-backward for Meta+Delete (Option+Backspace via Ink)', () => {
    expect(resolveEditAction('', { ...noMods, meta: true, delete: true })).toBe('delete-word-backward');
  });

  it('returns delete-word-backward for Ctrl+Backspace', () => {
    expect(resolveEditAction('', { ...noMods, ctrl: true, backspace: true })).toBe('delete-word-backward');
  });

  it('returns delete-word-backward for Ctrl+Delete', () => {
    expect(resolveEditAction('', { ...noMods, ctrl: true, delete: true })).toBe('delete-word-backward');
  });

  it('returns delete-line-backward for Super+Backspace (Cmd+Backspace via Kitty)', () => {
    expect(resolveEditAction('', { ...noMods, super: true, backspace: true })).toBe('delete-line-backward');
  });

  it('returns delete-line-backward for Super+Delete (Cmd+Backspace via Ink Kitty)', () => {
    expect(resolveEditAction('', { ...noMods, super: true, delete: true })).toBe('delete-line-backward');
  });

  it('returns move-line-start for Ctrl+A', () => {
    expect(resolveEditAction('a', { ...noMods, ctrl: true })).toBe('move-line-start');
  });

  it('returns move-line-end for Ctrl+E', () => {
    expect(resolveEditAction('e', { ...noMods, ctrl: true })).toBe('move-line-end');
  });

  it('returns null for no special combo', () => {
    expect(resolveEditAction('a', noMods)).toBeNull();
  });

  it('returns null for regular delete without meta', () => {
    expect(resolveEditAction('', { ...noMods, delete: true })).toBeNull();
  });
});

describe('applyEditAction', () => {
  it('returns null for null action', () => {
    expect(applyEditAction(null, 'hello', 5)).toBeNull();
  });

  it('delegates delete-word-backward', () => {
    expect(applyEditAction('delete-word-backward', 'hello world', 11)).toEqual({ value: 'hello ', cursor: 6 });
  });

  it('delegates delete-word-forward', () => {
    expect(applyEditAction('delete-word-forward', 'hello world', 0)).toEqual({ value: 'world', cursor: 0 });
  });

  it('delegates delete-line-backward', () => {
    expect(applyEditAction('delete-line-backward', 'line1\nline2', 11)).toEqual({ value: 'line1\n', cursor: 6 });
  });

  it('delegates delete-line-forward', () => {
    expect(applyEditAction('delete-line-forward', 'hello world', 5)).toEqual({ value: 'hello', cursor: 5 });
  });

  it('delegates move-line-start', () => {
    expect(applyEditAction('move-line-start', 'hello', 3)).toEqual({ value: 'hello', cursor: 0 });
  });

  it('delegates move-line-end', () => {
    expect(applyEditAction('move-line-end', 'hello', 2)).toEqual({ value: 'hello', cursor: 5 });
  });
});
