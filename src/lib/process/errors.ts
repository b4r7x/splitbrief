import { error, matches } from '../../utils/error.js';
import { redactSecrets } from '../../utils/redact.js';

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

export function isENOENT(err: unknown): boolean {
  return isNodeError(err) && err.code === 'ENOENT';
}

export interface TimeoutErrorOptions {
  command: string;
  label?: string | undefined;
  timeoutMs: number;
  output: string;
}

export interface ExitCodeErrorOptions {
  command: string;
  label?: string | undefined;
  code: number | null;
  stderr: string;
  output?: string | undefined;
}

export const processError = {
  notFound: (command: string, message?: string) =>
    error('command-not-found', message ?? `Command not found: ${command}`, { command, message }),

  timeout: (opts: TimeoutErrorOptions) => {
    const subject = opts.label ?? opts.command;
    const seconds = Math.round(opts.timeoutMs / 1000);
    return error('command-timeout', `${subject} timed out after ${seconds}s`, {
      command: opts.command,
      label: opts.label,
      timeoutMs: opts.timeoutMs,
      output: opts.output,
    });
  },

  exitCode: (opts: ExitCodeErrorOptions) => {
    const subject = opts.label ?? opts.command;
    const detail = opts.stderr?.trim();
    const message = `${subject} exited with code ${opts.code}${detail ? `: ${detail}` : ''}`;
    return error('process-output', redactSecrets(message), {
      command: opts.command,
      label: opts.label,
      code: opts.code,
      stderr: redactSecrets(opts.stderr ?? ''),
      output: redactSecrets(opts.output ?? opts.stderr ?? ''),
    });
  },

  isNotFound: matches('command-not-found'),
  isTimeout: matches('command-timeout'),
  isExitCode: (err: unknown): err is ProcessOutputError =>
    err instanceof Error && (err as { kind?: unknown }).kind === 'process-output',
} as const;

export interface ProcessOutputErrorData {
  command: string;
  label?: string | undefined;
  code: number | null;
  stderr: string;
  output: string;
}

export type ProcessOutputError = Error & {
  readonly kind: 'process-output';
  readonly data: ProcessOutputErrorData;
};
