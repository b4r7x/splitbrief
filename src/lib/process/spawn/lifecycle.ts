import { spawn, type ChildProcess } from 'node:child_process';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text.js';
import { error, matches } from '../../../utils/error.js';
import { createBoundedOutput, type BoundedOutputMetadata } from '../bounded-output.js';
import { spawnError, processError } from '../errors.js';
import {
  registerProcess,
  unregisterProcess,
  killProcess,
  abortProcess,
  processTreeReapingLimitation,
} from '../registry.js';

export const DEFAULT_PROCESS_OUTPUT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_PROCESS_STDERR_MAX_BYTES = 256 * 1024;
export const DEFAULT_PROCESS_LINE_MAX_BYTES = 1024 * 1024;

const CHILD_RUNTIME_ENV_KEYS = [
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'NO_COLOR',
  'FORCE_COLOR',
  'COLUMNS',
  'LINES',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
] as const;

const CHILD_CONTROL_ENV_KEYS = new Set([
  'HOME',
  'USERPROFILE',
  'PATH',
  'PWD',
  'OLDPWD',
  'INIT_CWD',
  'CDPATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'RUBYOPT',
  'PERL5OPT',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_userconfig',
]);

export function isSafePreservedChildEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !CHILD_CONTROL_ENV_KEYS.has(key);
}

export function createSanitizedChildEnv(
  source: NodeJS.ProcessEnv,
  preserveKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_RUNTIME_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of new Set(preserveKeys)) {
    const value = source[key];
    if (value !== undefined && isSafePreservedChildEnvKey(key)) env[key] = value;
  }
  return env;
}

export type SpawnPipeFatalState = 'output-budget-breach' | 'protocol-failure' | 'callback-failure';

export interface SpawnPipeFatalSignal {
  state: SpawnPipeFatalState;
  remediation: string;
}

export interface SpawnPipeFatalOutcome extends SpawnPipeFatalSignal {
  stdout: string;
  stderr: string;
  stdoutMetadata: BoundedOutputMetadata;
  stderrMetadata: BoundedOutputMetadata;
}

type SpawnPipeCallbackResult = SpawnPipeFatalSignal | undefined;

export const spawnPipeError = {
  stdinIncomplete: (cause?: unknown) =>
    error(
      'process-stdin-incomplete',
      'Process stdin closed before all input was delivered',
      undefined,
      cause,
    ),
  isStdinIncomplete: matches('process-stdin-incomplete'),
} as const;

export interface SpawnIdleOptions {
  warnMs: number;
  killMs: number;
  onWarn?: ((silentMs: number) => void) | undefined;
  onClear?: (() => void) | undefined;
}

interface SpawnPipeOptions<T> {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  detached?: boolean | undefined;
  ledger?: boolean | undefined;
  stdin?: string | undefined;
  signal?: AbortSignal | undefined;
  idle?: SpawnIdleOptions | undefined;
  outputBudgetBytes?: number | undefined;
  partialStdoutMaxBytes?: number | undefined;
  partialStderrMaxBytes?: number | undefined;
  onStdout: (chunk: string) => SpawnPipeCallbackResult;
  onStderr: (chunk: string) => SpawnPipeCallbackResult;
  onClose: (code: number | null, signal: string | null) => T | Promise<T>;
  onError?: ((err: NodeJS.ErrnoException) => Error | null) | undefined;
  onSpawned?: ((proc: ChildProcess) => void) | undefined;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function defaultFatalRemediation(state: SpawnPipeFatalState): string {
  switch (state) {
    case 'output-budget-breach':
      return 'Reduce the requested output or increase the configured output budget.';
    case 'protocol-failure':
      return 'Check the CLI version and output protocol, then retry.';
    case 'callback-failure':
      return 'Resolve the callback error, then retry.';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

export function isFatalSignal(value: unknown): value is SpawnPipeFatalSignal {
  if (typeof value !== 'object' || value === null) return false;
  if (!('state' in value) || !('remediation' in value)) return false;
  const state = value.state;
  return (
    (state === 'output-budget-breach' ||
      state === 'protocol-failure' ||
      state === 'callback-failure') &&
    typeof value.remediation === 'string'
  );
}

export function spawnPipe<T>(opts: SpawnPipeOptions<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    // The POSIX detached process-group contract is what lets every fatal,
    // timeout, abort, and shutdown path prove descendant reaping. Node's
    // `detached: false` Windows fallback only kills the leader, so launching
    // it would make a later success claim unverifiable. Fail before spawn.
    if (process.platform === 'win32') {
      reject(processTreeReapingLimitation());
      return;
    }
    if (opts.signal?.aborted) {
      reject(opts.signal.reason ?? abortError());
      return;
    }

    const idle = opts.idle;
    let idleWarned = false;
    let idleWarnTimer: NodeJS.Timeout | undefined;
    let idleKillTimer: NodeJS.Timeout | undefined;
    const clearIdleTimers = () => {
      if (idleWarnTimer !== undefined) clearTimeout(idleWarnTimer);
      if (idleKillTimer !== undefined) clearTimeout(idleKillTimer);
      idleWarnTimer = undefined;
      idleKillTimer = undefined;
    };

    const partialStdout = createBoundedOutput({
      maxBytes: opts.partialStdoutMaxBytes ?? DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
      policy: 'prefix-tail',
    });
    const partialStderr = createBoundedOutput({
      maxBytes: opts.partialStderrMaxBytes ?? DEFAULT_PROCESS_STDERR_MAX_BYTES,
      policy: 'tail',
    });
    const outputBudgetBytes =
      opts.outputBudgetBytes === undefined
        ? undefined
        : Number.isFinite(opts.outputBudgetBytes)
          ? Math.max(0, Math.floor(opts.outputBudgetBytes))
          : 0;
    let outputBytesSeen = 0;
    let proc: ChildProcess;
    let phase: 'active' | 'terminating' | 'settled' = 'active';
    let stdinWriteComplete = opts.stdin === undefined;
    let stdinEndComplete = false;
    let removeAbortListener: (() => void) | undefined;
    const cleanup = () => {
      clearIdleTimers();
      removeAbortListener?.();
      removeAbortListener = undefined;
    };
    const fail = (err: unknown) => {
      if (phase !== 'active') return;
      phase = 'settled';
      cleanup();
      reject(err);
    };
    const done = (value: T) => {
      if (phase !== 'active') return;
      phase = 'settled';
      cleanup();
      resolve(value);
    };
    const fatalOutcome = (signal: SpawnPipeFatalSignal): SpawnPipeFatalOutcome => {
      const stdoutMetadata = partialStdout.snapshot();
      const stderrMetadata = partialStderr.snapshot();
      const remediation = sanitizeTerminalDiagnosticText(signal.remediation).trim();
      return {
        state: signal.state,
        remediation: remediation || defaultFatalRemediation(signal.state),
        stdout: stdoutMetadata.text,
        stderr: stderrMetadata.text,
        stdoutMetadata,
        stderrMetadata,
      };
    };
    const terminate = (
      reason: { kind: 'fatal'; signal: SpawnPipeFatalSignal } | { kind: 'error'; error: unknown },
    ) => {
      if (phase !== 'active') return;
      phase = 'terminating';
      cleanup();
      proc.stdout?.pause();
      proc.stderr?.pause();
      const settleTermination = (err: unknown, unregister: boolean) => {
        if (phase !== 'terminating') return;
        phase = 'settled';
        if (unregister) unregisterProcess(proc);
        reject(err);
      };
      void killProcess(proc, { group: opts.detached ?? false }).then(
        () =>
          settleTermination(
            reason.kind === 'fatal' ? fatalOutcome(reason.signal) : reason.error,
            true,
          ),
        (err) => settleTermination(err, false),
      );
    };
    const terminateFatal = (signal: SpawnPipeFatalSignal) => {
      terminate({ kind: 'fatal', signal });
    };
    // Only callbacks that are contractually allowed to signal fatality are guarded by result:
    // a `void` callback may legally return a value under TypeScript's return-type bivariance, so
    // treating that value as a fatal signal would kill the child for a harmless expression body.
    const invokeGuarded = (callback: () => SpawnPipeCallbackResult): boolean => {
      if (phase !== 'active') return false;
      try {
        const result = callback();
        if (result === undefined) return true;
        if (isFatalSignal(result)) {
          terminateFatal(result);
          return false;
        }
      } catch {
        terminateFatal({ state: 'callback-failure', remediation: '' });
        return false;
      }
      terminateFatal({ state: 'callback-failure', remediation: '' });
      return false;
    };
    const invokeVoidGuarded = (callback: () => void): boolean =>
      invokeGuarded(() => {
        callback();
        return undefined;
      });

    const armIdleTimers = () => {
      if (idle === undefined) return;
      clearIdleTimers();
      const since = Date.now();
      idleWarnTimer = setTimeout(() => {
        idleWarned = true;
        if (idle.onWarn !== undefined) {
          invokeVoidGuarded(() => idle.onWarn?.(Date.now() - since));
        }
      }, idle.warnMs);
      idleWarnTimer.unref?.();
      idleKillTimer = setTimeout(() => {
        terminate({
          kind: 'error',
          error: processError.idleTimeout({ command: opts.command, idleMs: idle.killMs }),
        });
      }, idle.killMs);
      idleKillTimer.unref?.();
    };
    const noteIdleOutput = () => {
      if (idle === undefined || phase !== 'active') return phase === 'active';
      if (idleWarned) {
        idleWarned = false;
        if (idle.onClear !== undefined && !invokeVoidGuarded(() => idle.onClear?.())) return false;
      }
      armIdleTimers();
      return phase === 'active';
    };
    try {
      proc = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: opts.detached ?? false,
        shell: false,
      });
    } catch (err: unknown) {
      fail(err);
      return;
    }

    registerProcess(proc, { group: opts.detached ?? false, ledger: opts.ledger });

    const { stdout, stderr, stdin } = proc;
    if (!stdout || !stderr || !stdin) {
      terminate({ kind: 'error', error: spawnError.streamsUnavailable() });
      return;
    }

    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      partialStdout.append(chunk);
      outputBytesSeen += Buffer.byteLength(chunk, 'utf8');
      if (outputBudgetBytes !== undefined && outputBytesSeen >= outputBudgetBytes) {
        terminateFatal({ state: 'output-budget-breach', remediation: '' });
        return;
      }
      if (!noteIdleOutput()) return;
      invokeGuarded(() => opts.onStdout(chunk));
    });
    stderr.on('data', (chunk: string) => {
      partialStderr.append(chunk);
      outputBytesSeen += Buffer.byteLength(chunk, 'utf8');
      if (outputBudgetBytes !== undefined && outputBytesSeen >= outputBudgetBytes) {
        terminateFatal({ state: 'output-budget-breach', remediation: '' });
        return;
      }
      if (!noteIdleOutput()) return;
      invokeGuarded(() => opts.onStderr(chunk));
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      unregisterProcess(proc);
      try {
        const mapped = opts.onError?.(err);
        fail(mapped ?? err);
      } catch {
        terminateFatal({ state: 'callback-failure', remediation: '' });
      }
    });

    proc.on('close', (code, signal) => {
      clearIdleTimers();
      if (phase !== 'active') {
        unregisterProcess(proc);
        return;
      }
      if (opts.stdin !== undefined && (!stdinWriteComplete || !stdinEndComplete)) {
        terminate({ kind: 'error', error: spawnPipeError.stdinIncomplete() });
        return;
      }
      unregisterProcess(proc);
      const failAfterClose = (err: unknown) => {
        if (phase !== 'active') return;
        if (isFatalSignal(err)) {
          terminateFatal(err);
          return;
        }
        terminate({ kind: 'error', error: err });
      };
      try {
        Promise.resolve(opts.onClose(code, signal)).then(done, failAfterClose);
      } catch (err: unknown) {
        failAfterClose(err);
      }
    });

    stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (opts.stdin === undefined && err.code === 'EPIPE') return;
      terminate({
        kind: 'error',
        error: opts.stdin === undefined ? err : spawnPipeError.stdinIncomplete(err),
      });
    });

    if (opts.signal !== undefined) {
      const signal = opts.signal;
      const onAbort = () => {
        if (phase !== 'active') return;
        phase = 'terminating';
        cleanup();
        proc.stdout?.pause();
        proc.stderr?.pause();
        const settleAbort = (err: unknown, unregister: boolean) => {
          if (phase !== 'terminating') return;
          phase = 'settled';
          if (unregister) unregisterProcess(proc);
          reject(err);
        };
        void abortProcess(proc, signal, { group: opts.detached ?? false }).then(
          () => settleAbort(signal.reason ?? abortError(), true),
          (err) => settleAbort(err, false),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        onAbort();
        return;
      }
    }

    if (opts.onSpawned !== undefined && !invokeVoidGuarded(() => opts.onSpawned?.(proc))) return;
    armIdleTimers();

    if (opts.stdin === undefined) {
      stdin.end(() => {
        stdinEndComplete = true;
      });
      return;
    }

    stdin.write(opts.stdin, (err) => {
      if (err) {
        terminate({ kind: 'error', error: spawnPipeError.stdinIncomplete(err) });
        return;
      }
      stdinWriteComplete = true;
    });
    stdin.end(() => {
      stdinEndComplete = true;
    });
  });
}
