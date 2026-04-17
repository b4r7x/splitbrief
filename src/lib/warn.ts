import { toErrorMessage } from '../utils/format-errors.js';

export function warnStderr(message: string): void {
  process.stderr.write(`\x1b[2m${message}\x1b[0m\n`);
}

export function warnError(context: string, err: unknown): void {
  warnStderr(`${context}: ${toErrorMessage(err)}`);
}
