import { toErrorMessage } from '../utils/format-errors.js';

export type CliError = Error & { readonly exitCode: number };

export function cliError(message: string, exitCode = 1): CliError {
  return Object.assign(new Error(message), { exitCode });
}

export function isCliError(err: unknown): err is CliError {
  return err instanceof Error
    && 'exitCode' in err
    && typeof (err as { exitCode: unknown }).exitCode === 'number';
}

export function rethrowAsCli(err: unknown): never {
  if (isCliError(err)) throw err;
  throw cliError(toErrorMessage(err), 1);
}
