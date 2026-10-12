import { toErrorMessage } from '../utils/format-errors.js';
import { sanitizeTerminalDiagnosticText } from '../utils/display-text.js';

export function warnStderr(message: string): void {
  process.stderr.write(`\x1b[2m${sanitizeTerminalDiagnosticText(message)}\x1b[0m\n`);
}

export function warnError(context: string, err?: unknown): void {
  warnStderr(err === undefined ? context : `${context}: ${toErrorMessage(err)}`);
}
