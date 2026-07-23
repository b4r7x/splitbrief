import { spawn, type ChildProcess } from 'node:child_process';
import { spawnError, processError } from '../errors.js';
import { registerProcess, unregisterProcess, killProcess, abortProcess } from '../registry.js';

export const DEFAULT_PROCESS_OUTPUT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_PROCESS_STDERR_MAX_BYTES = 256 * 1024;
export const DEFAULT_PROCESS_LINE_MAX_BYTES = 1024 * 1024;

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
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  onClose: (code: number | null, signal: string | null) => T | Promise<T>;
  onError?: ((err: NodeJS.ErrnoException) => Error | null) | undefined;
  onSpawned?: ((proc: ChildProcess) => void) | undefined;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function spawnPipe<T>(opts: SpawnPipeOptions<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }

    const idle = opts.idle;
    let idleKilledAfterMs: number | null = null;
    let idleWarned = false;
    let idleWarnTimer: NodeJS.Timeout | undefined;
    let idleKillTimer: NodeJS.Timeout | undefined;
    const clearIdleTimers = () => {
      if (idleWarnTimer !== undefined) clearTimeout(idleWarnTimer);
      if (idleKillTimer !== undefined) clearTimeout(idleKillTimer);
      idleWarnTimer = undefined;
      idleKillTimer = undefined;
    };

    let proc: ChildProcess;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearIdleTimers();
      reject(err);
    };
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      clearIdleTimers();
      resolve(value);
    };

    const armIdleTimers = () => {
      if (idle === undefined) return;
      clearIdleTimers();
      const since = Date.now();
      idleWarnTimer = setTimeout(() => {
        idleWarned = true;
        idle.onWarn?.(Date.now() - since);
      }, idle.warnMs);
      idleWarnTimer.unref?.();
      idleKillTimer = setTimeout(() => {
        idleKilledAfterMs = idle.killMs;
        killProcess(proc, { group: opts.detached ?? false });
      }, idle.killMs);
      idleKillTimer.unref?.();
    };
    const noteIdleOutput = () => {
      if (idle === undefined || settled || idleKilledAfterMs !== null) return;
      if (idleWarned) {
        idleWarned = false;
        idle.onClear?.();
      }
      armIdleTimers();
    };
    try {
      proc = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: opts.detached ?? false,
      });
    } catch (err: unknown) {
      fail(err);
      return;
    }

    registerProcess(proc, { group: opts.detached ?? false, ledger: opts.ledger });
    opts.onSpawned?.(proc);

    if (opts.signal) {
      abortProcess(proc, opts.signal, { group: opts.detached ?? false });
    }

    const { stdout, stderr, stdin } = proc;
    if (!stdout || !stderr || !stdin) {
      unregisterProcess(proc);
      fail(spawnError.streamsUnavailable());
      return;
    }

    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      noteIdleOutput();
      opts.onStdout(chunk);
    });
    stderr.on('data', (chunk: string) => {
      noteIdleOutput();
      opts.onStderr(chunk);
    });
    armIdleTimers();

    proc.on('error', (err: NodeJS.ErrnoException) => {
      unregisterProcess(proc);
      const mapped = opts.onError?.(err);
      fail(mapped ?? err);
    });

    proc.on('close', (code, signal) => {
      clearIdleTimers();
      unregisterProcess(proc);
      if (opts.signal?.aborted) {
        fail(abortError());
        return;
      }
      if (idleKilledAfterMs !== null) {
        fail(processError.idleTimeout({ command: opts.command, idleMs: idleKilledAfterMs }));
        return;
      }
      try {
        Promise.resolve(opts.onClose(code, signal)).then(done, fail);
      } catch (err: unknown) {
        fail(err);
      }
    });

    stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return;
      // The child may still be running: kill it and let the 'close' handler
      // unregister + release its ledger entry. Unregistering here would leave a
      // live process invisible to killAllProcesses and the orphan reaper.
      killProcess(proc, { group: opts.detached ?? false });
      fail(err);
    });

    if (opts.stdin === undefined) {
      stdin.end();
      return;
    }

    if (stdin.write(opts.stdin)) {
      stdin.end();
      return;
    }

    stdin.once('drain', () => stdin.end());
  });
}
