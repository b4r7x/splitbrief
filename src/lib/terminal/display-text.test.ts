import { describe, expect, it } from 'vitest';
import {
  getTerminalCellWidth,
  padTerminalDisplayTextEnd,
  stripTerminalControls,
  truncateTerminalDisplayText,
} from './display-text.js';

describe('stripTerminalControls', () => {
  it('removes ESC, BEL, OSC, CSI, and C0/C1 controls from display text', () => {
    const text = 'a\u001b[31mb\u001b[0mc\u0007d\u001b]0;owned\u0007e\u009b2Kf\u009dtitle\u009cg\nh';

    expect(stripTerminalControls(text)).toBe('abcdefgh');
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
});

describe('padTerminalDisplayTextEnd', () => {
  it('pads by cells after sanitizing display text', () => {
    expect(padTerminalDisplayTextEnd('\u001b[31m界e\u0301', 4)).toBe('界e\u0301 ');
  });

  it('pads emoji-presentation graphemes by their displayed cell width', () => {
    expect(padTerminalDisplayTextEnd('©️', 4)).toBe('©️  ');
  });
});
