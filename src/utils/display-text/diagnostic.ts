import { sanitizeTerminalDisplayText } from './sanitize.js';
import { ELLIPSIS } from './truncate.js';

export const DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS = 4000;

export interface TerminalDiagnosticTextOptions {
  maxChars?: number | undefined;
  preserveLineBreaks?: boolean | undefined;
}

export function sanitizeTerminalDiagnosticText(
  text: string,
  opts: TerminalDiagnosticTextOptions = {},
): string {
  return truncateDiagnosticText(
    sanitizeTerminalDisplayText(text, { preserveLineBreaks: opts.preserveLineBreaks }),
    opts.maxChars ?? DEFAULT_TERMINAL_DIAGNOSTIC_MAX_CHARS,
  );
}

function truncateDiagnosticText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  if (maxChars <= ELLIPSIS.length) return ELLIPSIS.slice(0, maxChars);
  return `${text.slice(0, maxChars - ELLIPSIS.length)}${ELLIPSIS}`;
}
