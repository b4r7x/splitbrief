import { error, matches, type AppError } from '../utils/error.js';
import { toErrorMessage } from '../utils/format-errors.js';
import { isRecord } from '../utils/type-guards.js';

export type CliError = AppError<'cli-error', { exitCode: number }> & {
  readonly name: 'CliError';
  readonly exitCode: number;
};

const isCliErrorKind = matches('cli-error');

export function cliError(message: string, exitCode = 1): CliError {
  const name: CliError['name'] = 'CliError';
  return Object.assign(error('cli-error', message, { exitCode }), { name, exitCode });
}

export function isCliError(err: unknown): err is CliError {
  return isCliErrorKind(err) && isRecord(err) && typeof err.exitCode === 'number';
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
