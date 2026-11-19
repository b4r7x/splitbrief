import { describe, expect, it } from 'vitest';
import {
  normalizeDisplayLabel,
  sanitizeTerminalDisplayText,
  stripTerminalControls,
} from './sanitize.js';

describe('stripTerminalControls', () => {
  it('removes ESC, BEL, OSC, CSI, and C0/C1 controls from display text', () => {
    const text = 'a\u001b[31mb\u001b[0mc\u0007d\u001b]0;owned\u0007e\u009b2Kf\u009dtitle\u009cg\nh';

    expect(stripTerminalControls(text)).toBe('abcdefg h');
  });

  it.each([
    ['save', '\u001b7'],
    ['restore', '\u001b8'],
  ])('removes the cursor %s sequence', (_, sequence) => {
    expect(stripTerminalControls(sequence)).toBe('');
  });

  it('keeps printed digits when removing a cursor restore sequence', () => {
    expect(stripTerminalControls('8')).toBe('8');
    expect(stripTerminalControls('Error 8\u001b8')).toBe('Error 8');
  });

  it('turns each run of line breaks and tabs into one space on one row', () => {
    expect(stripTerminalControls('a\nb')).toBe('a b');
    expect(stripTerminalControls('a\r\nb')).toBe('a b');
    expect(stripTerminalControls('a\n\n\tb')).toBe('a b');
    expect(stripTerminalControls('a\n\u0000\nb')).toBe('a b');
  });

  it('keeps line breaks and turns each tab into a space in the line-break mode', () => {
    expect(stripTerminalControls('a\r\nb\n\tc\rd', { preserveLineBreaks: true })).toBe(
      'a\nb\n c\nd',
    );
    expect(stripTerminalControls('\t\tx\u000by\u000cz', { preserveLineBreaks: true })).toBe(
      '  x y z',
    );
  });

  it('strips an escape sequence whole, with no extra space for a line break inside it', () => {
    expect(stripTerminalControls('a\u001b]0;ti\ntle\u0007b')).toBe('ab');
    expect(stripTerminalControls('a\n\u001b]8;;x\ny\u0007\nb')).toBe('a b');
    expect(stripTerminalControls('a\u001b[31m\nb\u001b[0m')).toBe('a b');
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
