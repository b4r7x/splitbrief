import {
  sanitizeTerminalDiagnosticText,
  type TerminalDiagnosticTextOptions,
} from './display-text.js';

export function toErrorMessage(err: unknown, opts: TerminalDiagnosticTextOptions = {}): string {
  return sanitizeTerminalDiagnosticText(err instanceof Error ? err.message : String(err), opts);
}

export const labelError = (action: string, err: unknown): string =>
  `${action}: ${toErrorMessage(err)}`;
