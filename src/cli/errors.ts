import { toErrorMessage } from '../utils/format-errors.js';

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function cliError(message: string, exitCode = 1): CliError {
  return new CliError(message, exitCode);
}

export function isCliError(err: unknown): err is CliError {
  return err instanceof CliError;
}

export function rethrowAsCli(err: unknown): never {
  if (isCliError(err)) throw err;
  throw cliError(toErrorMessage(err), 1);
}

export async function withCliErrors<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    rethrowAsCli(err);
  }
}
