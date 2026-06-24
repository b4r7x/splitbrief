import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS,
  getTerminalCellWidth,
  iterateTerminalGraphemes,
  padTerminalDisplayTextEnd,
  sanitizeTerminalDisplayText,
  sanitizeTerminalDiagnosticText,
  stripTerminalControls,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
  truncateTerminalDisplayTextStart,
} from './display-text.js';

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
});

describe('iterateTerminalGraphemes', () => {
  it('preserves line breaks on demand without splitting grapheme clusters', () => {
    expect(
      Array.from(iterateTerminalGraphemes('e\u0301\n👩‍💻', { preserveLineBreaks: true })),
    ).toEqual(['e\u0301', '\n', '👩‍💻']);
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
      "sed -n '1,260p' /Users/voitz/.agents/library/codebase-exploration/SKILL.md",
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

describe('padTerminalDisplayTextEnd', () => {
  it('pads by cells after sanitizing display text', () => {
    expect(padTerminalDisplayTextEnd('\u001b[31m界e\u0301', 4)).toBe('界e\u0301 ');
  });

  it('pads emoji-presentation graphemes by their displayed cell width', () => {
    expect(padTerminalDisplayTextEnd('©️', 4)).toBe('©️  ');
  });
});
