import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS,
  sanitizeTerminalDiagnosticText,
} from './diagnostic.js';

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

  it('shows a line break as one space, so the words on each side stay apart', () => {
    expect(sanitizeTerminalDiagnosticText('a\nb')).toBe('a b');
    expect(sanitizeTerminalDiagnosticText('a\r\nb')).toBe('a b');
    expect(sanitizeTerminalDiagnosticText('a\n\n\tb')).toBe('a b');
    expect(sanitizeTerminalDiagnosticText('a\r\nb\tc', { preserveLineBreaks: true })).toBe(
      'a\nb c',
    );
  });

  it('bounds the result and redacts a token next to a line break', () => {
    expect(sanitizeTerminalDiagnosticText('alpha\nbeta\ngamma', { maxChars: 8 })).toBe('alpha b…');
    expect(
      sanitizeTerminalDiagnosticText('TOKEN=abcdefghijklmnopqrstuvwxyz1234567890abcdef\nnext'),
    ).toBe('TOKEN=***REDACTED*** next');
  });

  it('uses the default terminal diagnostic bound', () => {
    const result = sanitizeTerminalDiagnosticText(
      'x'.repeat(DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS + 10),
    );

    expect(result).toHaveLength(DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS);
    expect(result.endsWith('…')).toBe(true);
  });
});
