import { error, matches } from '../../utils/error.js';
import { sanitizeTerminalDiagnosticText } from '../../utils/display-text.js';

export const spawnError = {
  streamsUnavailable: () => error('process-streams-unavailable', 'Process streams not available'),
} as const;

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

export interface IdleTimeoutErrorOptions {
  command: string;
  label?: string | undefined;
  idleMs: number;
}

export interface ExitCodeErrorOptions {
  command: string;
  label?: string | undefined;
  code: number | null;
  stderr: string;
  output?: string | undefined;
  detail?: string | undefined;
}

export type ProcessTerminationTarget = 'process' | 'process-group';

export type PlatformLimitationErrorOptions =
  | {
      operation: 'signal';
      target: ProcessTerminationTarget;
      signal: NodeJS.Signals;
    }
  | {
      operation: 'verify-absence';
      target: ProcessTerminationTarget;
      signal: NodeJS.Signals | null;
    };

export const processError = {
  notFound: (command: string, message?: string) => {
    const safeCommand = sanitizeTerminalDiagnosticText(command);
    return error(
      'command-not-found',
      sanitizeTerminalDiagnosticText(message ?? `Command not found: ${safeCommand}`),
      {
        command: safeCommand,
        message: message === undefined ? undefined : sanitizeTerminalDiagnosticText(message),
      },
    );
  },

  timeout: (opts: TimeoutErrorOptions) => {
    const command = sanitizeTerminalDiagnosticText(opts.command);
    const label = opts.label === undefined ? undefined : sanitizeTerminalDiagnosticText(opts.label);
    const subject = label ?? command;
    const seconds = Math.round(opts.timeoutMs / 1000);
    return error('command-timeout', `${subject} timed out after ${seconds}s`, {
      command,
      label,
      timeoutMs: opts.timeoutMs,
      output: sanitizeTerminalDiagnosticText(opts.output, { preserveLineBreaks: true }),
    });
  },

  idleTimeout: (opts: IdleTimeoutErrorOptions) => {
    const command = sanitizeTerminalDiagnosticText(opts.command);
    const label = opts.label === undefined ? undefined : sanitizeTerminalDiagnosticText(opts.label);
    const subject = label ?? command;
    const seconds = Math.round(opts.idleMs / 1000);
    return error(
      'command-idle-timeout',
      `${subject} produced no output for ${seconds}s and was terminated`,
      {
        command,
        label,
        idleMs: opts.idleMs,
      },
    );
  },

  exitCode: (opts: ExitCodeErrorOptions) => {
    const command = sanitizeTerminalDiagnosticText(opts.command);
    const label = opts.label === undefined ? undefined : sanitizeTerminalDiagnosticText(opts.label);
    const subject = label ?? command;
    // Tool output is column-structured (formatter diffs, test reports); losing the
    // line breaks here flattens it into unreadable soup before any renderer sees it.
    const stderr = sanitizeTerminalDiagnosticText(opts.stderr, { preserveLineBreaks: true });
    const output = sanitizeTerminalDiagnosticText(opts.output ?? opts.detail ?? opts.stderr, {
      preserveLineBreaks: true,
    });
    const detail = stderr.trim() || sanitizeTerminalDiagnosticText(opts.detail ?? '').trim();
    const message = sanitizeTerminalDiagnosticText(
      `${subject} exited with code ${opts.code}${detail ? `: ${detail}` : ''}`,
    );
    return error('process-output', message, {
      command,
      label,
      code: opts.code,
      stderr,
      output,
    });
  },

  platformLimitation: (opts: PlatformLimitationErrorOptions, cause?: unknown) => {
    const message =
      opts.operation === 'signal'
        ? `Unable to send ${opts.signal} to ${opts.target}`
        : `${opts.target} absence could not be verified after ${opts.signal ?? 'shutdown'}`;
    return error(
      'platform-limitation',
      message,
      {
        operation: opts.operation,
        target: opts.target,
        signal: opts.signal,
      },
      cause,
    );
  },

  isNotFound: matches('command-not-found'),
  isTimeout: matches('command-timeout'),
  isIdleTimeout: matches('command-idle-timeout'),
  isExitCode: (err: unknown): err is ProcessOutputError => isProcessOutputError(err),
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

const isProcessOutputError = matches('process-output');
