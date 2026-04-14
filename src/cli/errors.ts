export type CliError = Error & { readonly exitCode: number };

export function cliError(message: string, exitCode = 1): CliError {
  const err = new Error(message) as CliError;
  (err as { exitCode: number }).exitCode = exitCode;
  return err;
}

export function isCliError(err: unknown): err is CliError {
  return err instanceof Error
    && typeof (err as unknown as Record<string, unknown>)['exitCode'] === 'number';
}
