import { redactSecrets } from '../../utils/redact.js';

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export function isENOENT(err: unknown): boolean {
  return isNodeError(err) && err.code === 'ENOENT';
}

// Error subclasses are the one allowed exception to the project's zero-class rule.
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

export type CommandErrorKind = 'not-found' | 'timeout' | 'exit-code' | 'spawn-failed';

export interface CommandErrorOptions {
  label?: string | undefined;
  command: string;
  code?: number | null | undefined;
  timeoutMs?: number | undefined;
  stderr?: string | undefined;
}

export function formatCommandError(kind: CommandErrorKind, opts: CommandErrorOptions): string {
  const subject = opts.label ?? opts.command;
  switch (kind) {
    case 'not-found': {
      const base = `Command not found: ${opts.command}`;
      return opts.label ? `${opts.label}: ${base}` : base;
    }
    case 'timeout':
      return `${subject} timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`;
    case 'exit-code': {
      const detail = opts.stderr?.trim();
      return `${subject} exited with code ${opts.code}${detail ? `: ${detail}` : ''}`;
    }
    case 'spawn-failed':
      return `${subject} failed to spawn`;
  }
}
