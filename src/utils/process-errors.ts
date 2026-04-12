import { redactSecrets } from './redact.js';

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export function isENOENT(err: unknown): boolean {
  return isNodeError(err) && err.code === 'ENOENT';
}

// Intentional class — `Error` subclasses are the one allowed exception to the
// project's zero-class rule, since `instanceof Error` is the standard pattern
// for distinguishing error types in catch blocks.
export class CommandNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandNotFoundError';
  }
}

export class CommandTimeoutError extends Error {
  readonly output: string;
  constructor(message: string, output: string) {
    super(message);
    this.name = 'CommandTimeoutError';
    this.output = output;
  }
}

// Intentional class: Error subclass
export class ProcessOutputError extends Error {
  readonly output: string;
  constructor(message: string, output: string) {
    super(message);
    this.name = 'ProcessOutputError';
    this.output = output;
  }
}

export function createProcessError(message: string, output: string): ProcessOutputError {
  return new ProcessOutputError(redactSecrets(message), redactSecrets(output));
}
