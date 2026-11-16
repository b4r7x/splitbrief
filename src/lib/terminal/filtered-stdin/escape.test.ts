import { describe, it, expect } from 'vitest';
import { readEscape } from './escape.js';
import { PASTE_START_BYTES } from './paste.js';

describe('filtered stdin escape sequences', () => {
  it('holds an incomplete paste start marker prefix', () => {
    const decision = readEscape(Buffer.from('\u001b[200'), false, true);
    expect(decision).toEqual({ kind: 'hold' });
  });

  it('recognizes a complete paste start marker', () => {
    const decision = readEscape(PASTE_START_BYTES, false, true);
    expect(decision).toEqual({ kind: 'paste-start', length: PASTE_START_BYTES.length });
  });
});

// A reply to the startup background query can arrive after the query gave up waiting. It is the
// terminal talking, not the user typing, so it never reaches Ink as keys.
describe('filtered stdin terminal replies', () => {
  it.each([
    ['an ST-terminated background reply', '\u001b]11;rgb:2424/2727/3a3a\u001b\\'],
    ['a BEL-terminated background reply', '\u001b]11;rgb:2424/2727/3a3a\u0007'],
    ['a device-attributes reply', '\u001b[?62;22c'],
    ['a mode reply about another mode', '\u001b[?2026;2$y'],
  ])('skips %s whole', (_label, reply) => {
    const source = Buffer.from(reply);

    expect(readEscape(source, false, true)).toEqual({ kind: 'skip', length: source.length });
    expect(readEscape(source, false, false)).toEqual({ kind: 'skip', length: source.length });
  });

  it.each([
    ['set', '1', true],
    ['permanently set', '3', true],
    ['not known', '0', false],
    ['reset', '2', false],
    ['permanently reset', '4', false],
  ])('reads the reply that bracketed paste is %s', (_label, state, brackets) => {
    const source = Buffer.from(`\u001b[?2004;${state}$y`);

    expect(readEscape(source, false, true)).toEqual({
      kind: 'paste-mode',
      length: source.length,
      brackets,
    });
  });

  it('holds a background reply that has not finished arriving', () => {
    expect(readEscape(Buffer.from('\u001b]11;rgb:24'), false, true)).toEqual({ kind: 'hold' });
  });

  it('still passes an arrow key through as text', () => {
    expect(readEscape(Buffer.from('\u001b[A'), false, true)).toEqual({ kind: 'text', length: 3 });
  });
});
