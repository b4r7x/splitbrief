import { spawn, type ChildProcess } from 'node:child_process';
import { gitDiscoveryCeiling } from '../../git/discovery.js';
import { createBoundedOutput, type BoundedOutput } from '../bounded-output.js';
import { withUserNodeEnv } from './child-env.js';
import { spawnError, processError } from '../errors.js';
import { registerProcess, unregisterProcess, processTreeReapingLimitation } from '../registry.js';
import {
  type SpawnPipeCallbackResult,
  DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
  DEFAULT_PROCESS_STDERR_MAX_BYTES,
  type SpawnClose,
  type SpawnPipeOptions,
  type SpawnRun,
} from './types.js';
import { abortError, isFatalSignal } from './fatal.js';
import { armIdleTimers, clearIdleTimers } from './idle-timers.js';
import { onStdinError, promptIncomplete, startStdin } from './stdin.js';
import {
  cleanup,
  finishClose,
  invokeGuarded,
  invokeVoidGuarded,
  reapDeferredFatal,
  terminate,
  terminateFatal,
  watchAbort,
} from './terminate.js';

function acceptsChunk(callback: () => SpawnPipeCallbackResult): boolean {
  try {
    const result = callback();
    return result === undefined || (isFatalSignal(result) && result.drainOutput === true);
  } catch {
    return false;
  }
}

function fail<T>(run: SpawnRun<T>, err: unknown): void {
  if (run.phase !== 'active') return;
  run.phase = 'settled';
  cleanup(run);
  run.reject(err);
}

function outputBudgetSpent<T>(run: SpawnRun<T>): boolean {
  return run.outputBudgetBytes !== undefined && run.outputBytesSeen >= run.outputBudgetBytes;
}

function armIdle<T>(run: SpawnRun<T>): void {
  const idle = run.opts.idle;
  if (idle === undefined) return;
  armIdleTimers(
    run.idleTimers,
    idle,
    (silentMs) => invokeVoidGuarded(run, () => idle.onWarn?.(silentMs)),
    (killMs) =>
      terminate(run, {
        kind: 'error',
        error: processError.idleTimeout({
          command: run.opts.command,
          label: idle.label,
          idleMs: killMs,
        }),
      }),
  );
}

function noteIdleOutput<T>(run: SpawnRun<T>): boolean {
  const idle = run.opts.idle;
  if (run.phase !== 'active') return false;
  if (idle === undefined || run.fatalDrain !== undefined) return true;
  if (run.idleTimers.warned) {
    run.idleTimers.warned = false;
    if (idle.onClear !== undefined && !invokeVoidGuarded(run, () => idle.onClear?.())) return false;
  }
  armIdle(run);
  return run.phase === 'active';
}

// Drained output only feeds the caller's diagnosis: the stdin failure is
// already the outcome, so a failing callback or a spent output budget ends
// delivery while the pipes still run to their close.
function drainChunk<T>(run: SpawnRun<T>, callback: () => SpawnPipeCallbackResult): void {
  const accepted = acceptsChunk(callback);
  if (!accepted || outputBudgetSpent(run)) run.phase = 'terminating';
}

function readOutput<T>(
  run: SpawnRun<T>,
  partial: BoundedOutput,
  chunk: string,
  deliver: () => SpawnPipeCallbackResult,
): void {
  partial.append(chunk);
  run.outputBytesSeen += Buffer.byteLength(chunk, 'utf8');
  if (run.phase === 'draining') {
    drainChunk(run, deliver);
    return;
  }
  if (!noteIdleOutput(run)) return;
  // The recording callback runs before the byte-budget kill so the
  // recorder's cumulative accounting observes the chunk and its own
  // envelope latch classifies the breach before the backstop fires.
  if (!invokeGuarded(run, deliver)) return;
  if (outputBudgetSpent(run))
    terminateFatal(run, { state: 'output-budget-breach', remediation: '' });
}

function onProcessError<T>(run: SpawnRun<T>, err: NodeJS.ErrnoException): void {
  unregisterProcess(run.proc);
  try {
    const mapped = run.opts.onError?.(err);
    fail(run, mapped ?? err);
  } catch {
    terminateFatal(run, { state: 'callback-failure', remediation: '' });
  }
}

function onClose<T>(run: SpawnRun<T>, code: number | null, signal: NodeJS.Signals | null): void {
  const closed = { code, signal };
  run.exit = { code };
  run.closed.resolve(closed);
  clearIdleTimers(run.idleTimers);
  if (run.phase !== 'active') {
    unregisterProcess(run.proc);
    return;
  }
  if (promptIncomplete(run)) {
    terminate(run, { kind: 'stdin-incomplete' });
    return;
  }
  if (run.fatalDrain !== undefined) reapDeferredFatal(run);
  else finishClose(run, closed);
}

function startRun<T>(run: SpawnRun<T>): void {
  const { opts, proc } = run;
  registerProcess(proc, { group: opts.detached ?? false });

  const { stdout, stderr, stdin } = proc;
  if (!stdout || !stderr || !stdin) {
    terminate(run, { kind: 'error', error: spawnError.streamsUnavailable() });
    return;
  }

  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');
  stdout.on('data', (chunk: string) =>
    readOutput(run, run.partialStdout, chunk, () => opts.onStdout(chunk)),
  );
  stderr.on('data', (chunk: string) =>
    readOutput(run, run.partialStderr, chunk, () => opts.onStderr(chunk)),
  );
  proc.on('error', (err: NodeJS.ErrnoException) => onProcessError(run, err));
  proc.on('close', (code, signal) => onClose(run, code, signal));
  stdin.on('error', (err: NodeJS.ErrnoException) => onStdinError(run, err));

  if (watchAbort(run)) return;
  if (opts.onSpawned !== undefined && !invokeVoidGuarded(run, () => opts.onSpawned?.(proc))) return;
  armIdle(run);
  startStdin(run, stdin);
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

    let proc: ChildProcess;
    try {
      const env = withUserNodeEnv(opts.env ?? process.env);
      const ceiling = gitDiscoveryCeiling(opts.cwd ?? process.cwd());
      proc = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: ceiling === undefined ? env : { ...env, GIT_CEILING_DIRECTORIES: ceiling },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: opts.detached ?? false,
        shell: false,
      });
    } catch (err: unknown) {
      reject(err);
      return;
    }

    startRun({
      opts,
      proc,
      phase: 'active',
      exit: undefined,
      closed: Promise.withResolvers<SpawnClose>(),
      fatalDrain: undefined,
      stdinWriteComplete: opts.stdin === undefined,
      stdinEndComplete: false,
      outputBytesSeen: 0,
      outputBudgetBytes:
        opts.outputBudgetBytes === undefined
          ? undefined
          : Number.isFinite(opts.outputBudgetBytes)
            ? Math.max(0, Math.floor(opts.outputBudgetBytes))
            : 0,
      partialStdout: createBoundedOutput({
        maxBytes: opts.partialStdoutMaxBytes ?? DEFAULT_PROCESS_OUTPUT_MAX_BYTES,
        policy: 'prefix-tail',
      }),
      partialStderr: createBoundedOutput({
        maxBytes: opts.partialStderrMaxBytes ?? DEFAULT_PROCESS_STDERR_MAX_BYTES,
        policy: 'tail',
      }),
      idleTimers: { warned: false, warn: undefined, kill: undefined },
      removeAbortListener: undefined,
      resolve,
      reject,
    });
  });
}
