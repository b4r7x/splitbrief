import { spawn, type ChildProcess } from 'node:child_process';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text.js';
import { error, matches, type AppError } from '../../../utils/error.js';
import { createBoundedOutput, type BoundedOutputMetadata } from '../bounded-output.js';
import { withUserNodeEnv } from './child-env.js';
import { spawnError, processError } from '../errors.js';
import {
  registerProcess,
  unregisterProcess,
  killProcess,
  abortProcess,
  processTreeReapingLimitation,
  SIGKILL_DELAY_MS,
} from '../registry.js';

export const DEFAULT_PROCESS_OUTPUT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_PROCESS_STDERR_MAX_BYTES = 256 * 1024;
export const DEFAULT_PROCESS_LINE_MAX_BYTES = 1024 * 1024;

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

/** How a child that broke its prompt closed; absent when it did not close within the grace. */
export type SpawnPipeExit = Readonly<{ code: number | null }>;

const isStdinIncompleteKind = matches('process-stdin-incomplete');

export const spawnPipeError = {
  stdinIncomplete: (cause?: unknown, exit?: SpawnPipeExit) =>
    error(
      'process-stdin-incomplete',
      'Process stdin closed before all input was delivered',
      exit,
      cause,
    ),
  stdinClosed: () => error('process-stdin-closed', 'Process stdin is closed'),
  isStdinClosed: matches('process-stdin-closed'),
  isStdinIncomplete: (
    err: unknown,
  ): err is AppError<'process-stdin-incomplete', SpawnPipeExit | undefined> =>
    isStdinIncompleteKind(err),
} as const;

export interface SpawnIdleOptions {
  warnMs: number;
  /** Opt-in cut on byte silence; unset, the watchdog only warns. */
  killMs?: number | undefined;
  /** Names the subject in the idle diagnostic so it need not carry the resolved binary path. */
  label?: string | undefined;
  onWarn?: ((silentMs: number) => void) | undefined;
  onClear?: (() => void) | undefined;
}

export type SpawnStdinWriter = Readonly<{
  write: (text: string) => Promise<void>;
  end: () => void;
}>;

interface SpawnPipeOptions<T> {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  detached?: boolean | undefined;
  ledger?: boolean | undefined;
  stdin?: string | undefined;
  stdinOptional?: boolean | undefined;
  onStdinReady?: ((writer: SpawnStdinWriter) => void) | undefined;
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

function isStdinReaderGone(err: Error): boolean {
  return 'code' in err && (err.code === 'EPIPE' || err.code === 'ENOTCONN');
}

function defaultFatalRemediation(state: SpawnPipeFatalState): string {
  switch (state) {
    case 'output-budget-breach':
      return 'The tool wrote more than 64 MB of output and was stopped. Narrow what it was asked to print, then retry.';
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

function acceptsChunk(callback: () => SpawnPipeCallbackResult): boolean {
  try {
    return callback() === undefined;
  } catch {
    return false;
  }
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
    let phase: 'active' | 'draining' | 'terminating' | 'settled' = 'active';
    const closed = Promise.withResolvers<void>();
    let exit: SpawnPipeExit | undefined;
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
    const closedWithin = (graceMs: number) =>
      new Promise<void>((resolveGrace) => {
        const grace = setTimeout(resolveGrace, graceMs);
        void closed.promise.then(() => {
          clearTimeout(grace);
          resolveGrace();
        });
      });
    const terminate = (
      reason:
        | { kind: 'fatal'; signal: SpawnPipeFatalSignal }
        | { kind: 'error'; error: unknown }
        | { kind: 'stdin-incomplete'; cause?: unknown },
    ) => {
      if (phase !== 'active') return;
      cleanup();
      // A child that quits before it reads its prompt breaks the pipe under it
      // while its last words (a usage limit, a dead login) are still in flight,
      // so its output keeps reaching the callbacks until it closes.
      const draining = reason.kind === 'stdin-incomplete';
      phase = draining ? 'draining' : 'terminating';
      if (!draining) {
        proc.stdout?.pause();
        proc.stderr?.pause();
      }
      const settleTermination = (err: unknown, unregister: boolean) => {
        if (phase === 'settled') return;
        phase = 'settled';
        if (unregister) unregisterProcess(proc);
        reject(err);
      };
      // A reaping failure is the one outcome that must replace the first cause:
      // the tree could not be verified dead, and the caller has to know that
      // rather than trusting a terminal classification.
      void killProcess(proc, { group: opts.detached ?? false })
        .then(() => (draining ? closedWithin(SIGKILL_DELAY_MS) : undefined))
        .then(
          () =>
            settleTermination(
              reason.kind === 'fatal'
                ? fatalOutcome(reason.signal)
                : reason.kind === 'stdin-incomplete'
                  ? spawnPipeError.stdinIncomplete(reason.cause, exit)
                  : reason.error,
              true,
            ),
          (err) => settleTermination(err, false),
        );
    };
    // Drained output only feeds the caller's diagnosis: the stdin failure is
    // already the outcome, so a failing callback or a spent output budget ends
    // delivery while the pipes still run to their close.
    const drainChunk = (callback: () => SpawnPipeCallbackResult) => {
      const accepted = acceptsChunk(callback);
      if (!accepted || (outputBudgetBytes !== undefined && outputBytesSeen >= outputBudgetBytes)) {
        phase = 'terminating';
      }
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

    const armIdleKillTimer = () => {
      const killMs = idle?.killMs;
      if (killMs === undefined) return;
      idleKillTimer = setTimeout(() => {
        terminate({
          kind: 'error',
          error: processError.idleTimeout({
            command: opts.command,
            label: idle?.label,
            idleMs: killMs,
          }),
        });
      }, killMs);
      idleKillTimer.unref?.();
    };
    const armIdleTimers = () => {
      if (idle === undefined) return;
      clearIdleTimers();
      const since = Date.now();
      idleWarnTimer = setTimeout(() => {
        idleWarned = true;
        if (idle.onWarn !== undefined) {
          // Node starts the timer from the cached loop time, which can be older than `since`, and
          // the wall clock can run behind the monotonic one, so the reading may be under warnMs.
          invokeVoidGuarded(() => idle.onWarn?.(Math.max(idle.warnMs, Date.now() - since)));
        }
      }, idle.warnMs);
      idleWarnTimer.unref?.();
      armIdleKillTimer();
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
        env: withUserNodeEnv(opts.env ?? process.env),
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
      if (phase === 'draining') {
        drainChunk(() => opts.onStdout(chunk));
        return;
      }
      if (!noteIdleOutput()) return;
      // The recording callback runs before the byte-budget kill so the
      // recorder's cumulative accounting observes the chunk and its own
      // envelope latch classifies the breach before the backstop fires.
      if (!invokeGuarded(() => opts.onStdout(chunk))) return;
      if (outputBudgetBytes !== undefined && outputBytesSeen >= outputBudgetBytes) {
        terminateFatal({ state: 'output-budget-breach', remediation: '' });
      }
    });
    stderr.on('data', (chunk: string) => {
      partialStderr.append(chunk);
      outputBytesSeen += Buffer.byteLength(chunk, 'utf8');
      if (phase === 'draining') {
        drainChunk(() => opts.onStderr(chunk));
        return;
      }
      if (!noteIdleOutput()) return;
      if (!invokeGuarded(() => opts.onStderr(chunk))) return;
      if (outputBudgetBytes !== undefined && outputBytesSeen >= outputBudgetBytes) {
        terminateFatal({ state: 'output-budget-breach', remediation: '' });
      }
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
      exit = { code };
      closed.resolve();
      clearIdleTimers();
      if (phase !== 'active') {
        unregisterProcess(proc);
        return;
      }
      if (
        opts.stdin !== undefined &&
        !opts.stdinOptional &&
        (!stdinWriteComplete || (opts.onStdinReady === undefined && !stdinEndComplete))
      ) {
        terminate({ kind: 'stdin-incomplete' });
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
      if (opts.onStdinReady !== undefined && stdinWriteComplete) return;
      if ((opts.stdin === undefined || opts.stdinOptional) && isStdinReaderGone(err)) return;
      terminate(
        opts.stdin === undefined
          ? { kind: 'error', error: err }
          : { kind: 'stdin-incomplete', cause: err },
      );
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

    const writer: SpawnStdinWriter = {
      write: (text) =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          if (phase !== 'active' || stdin.destroyed || stdin.writableEnded) {
            rejectWrite(spawnPipeError.stdinClosed());
            return;
          }
          stdin.write(text, (err) => {
            if (err) rejectWrite(err);
            else resolveWrite();
          });
        }),
      end: () => {
        if (stdin.destroyed || stdin.writableEnded) return;
        stdin.end(() => {
          stdinEndComplete = true;
        });
      },
    };
    if (opts.stdin === undefined && opts.onStdinReady !== undefined) {
      invokeVoidGuarded(() => opts.onStdinReady?.(writer));
      return;
    }
    if (opts.stdin === undefined) {
      stdin.end(() => {
        stdinEndComplete = true;
      });
      return;
    }

    stdin.write(opts.stdin, (err) => {
      if (err) {
        if (opts.stdinOptional && isStdinReaderGone(err)) return;
        terminate({ kind: 'stdin-incomplete', cause: err });
        return;
      }
      stdinWriteComplete = true;
      if (opts.onStdinReady !== undefined) {
        invokeVoidGuarded(() => opts.onStdinReady?.(writer));
      }
    });
    if (opts.onStdinReady !== undefined) return;
    stdin.end(() => {
      stdinEndComplete = true;
    });
  });
}
