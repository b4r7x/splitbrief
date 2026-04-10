// Intentional class — Error subclass for CLI exit-code propagation
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function cliError(message: string, exitCode = 1): CliError {
  return new CliError(message, exitCode);
}

export function isCliError(err: unknown): err is CliError {
  return err instanceof CliError;
}
