import { sanitizeTerminalDiagnosticText } from './display-text.js';

export function toErrorMessage(err: unknown): string {
  return sanitizeTerminalDiagnosticText(err instanceof Error ? err.message : String(err));
}

export const labelError = (action: string, err: unknown): string =>
  `${action}: ${toErrorMessage(err)}`;
