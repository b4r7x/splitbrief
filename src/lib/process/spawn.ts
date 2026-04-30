import { spawn, type ChildProcess } from 'node:child_process';
import { isENOENT, processError } from './errors.js';
import { createLineBuffer } from './line-buffer.js';
import { registerProcess, unregisterProcess, killProcess, abortProcess } from './registry.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

interface SpawnPipeOptions<T> {
  command: string;
  args: string[];
  cwd?: string | undefined;
  detached?: boolean | undefined;
  stdin?: string | undefined;
  signal?: AbortSignal | undefined;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  onClose: (code: number | null, signal: string | null) => T | Promise<T>;
  onError?: ((err: NodeJS.ErrnoException) => Error | null) | undefined;
  onSpawned?: ((proc: ChildProcess) => void) | undefined;
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function spawnPipe<T>(opts: SpawnPipeOptions<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }

    let proc: ChildProcess;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const done = (value: T) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      proc = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: opts.detached ?? false,
      });
    } catch (err: unknown) {
      fail(err);
      return;
    }

    registerProcess(proc);
    opts.onSpawned?.(proc);

    if (opts.signal) {
      abortProcess(proc, opts.signal, { group: opts.detached ?? false });
    }

    const { stdout, stderr, stdin } = proc;
    if (!stdout || !stderr || !stdin) {
      unregisterProcess(proc);
      fail(new Error('Process streams not available'));
      return;
    }

    stdout.on('data', (chunk: Buffer) => opts.onStdout(chunk.toString()));
    stderr.on('data', (chunk: Buffer) => opts.onStderr(chunk.toString()));

    proc.on('error', (err: NodeJS.ErrnoException) => {
      unregisterProcess(proc);
      const mapped = opts.onError?.(err);
      fail(mapped ?? err);
    });

    proc.on('close', (code, signal) => {
      unregisterProcess(proc);
      if (opts.signal?.aborted) {
        fail(abortError());
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
      unregisterProcess(proc);
      fail(err);
    });

    if (opts.stdin !== undefined) {
      stdin.write(opts.stdin);
    }
    stdin.end();
  });
}

export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string | undefined; timeout?: number | undefined },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeout = options?.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS;
  let stdout = '';
  let stderr = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  return spawnPipe({
    command,
    args,
    cwd: options?.cwd,
    onSpawned: (proc) => {
      timer = setTimeout(() => killProcess(proc), timeout);
    },
    onStdout: (chunk) => { stdout += chunk; },
    onStderr: (chunk) => { stderr += chunk; },
    onClose: (code) => {
      if (timer !== null) clearTimeout(timer);
      return { stdout, stderr, code: code ?? 1 };
    },
    onError: () => {
      if (timer !== null) clearTimeout(timer);
      return null;
    },
  });
}

export interface SpawnResult {
  output: string;
  code: number;
  timedOut: boolean;
  stderr: string;
}

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  timeout: number;
  onProgress: (text: string) => void;
  stdinInput?: string | undefined;
  notFoundMessage?: string | undefined;
  signal?: AbortSignal | undefined;
}

export function spawnWithTimeout(opts: SpawnOptions): Promise<SpawnResult> {
  let output = '';
  let stderrOutput = '';
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cleanupAbortTimer: (() => void) | null = null;

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  const clearProcessGuards = () => {
    clearTimer();
    cleanupAbortTimer?.();
    cleanupAbortTimer = null;
  };
  const clearTimerOnAbort = () => {
    clearTimer();
  };

  return spawnPipe({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    detached: true,
    stdin: opts.stdinInput,
    signal: opts.signal,
    onSpawned: (proc) => {
      timer = setTimeout(() => {
        timedOut = true;
        killProcess(proc, { group: true });
      }, opts.timeout);
      if (opts.signal?.aborted) {
        clearTimer();
        return;
      }
      opts.signal?.addEventListener('abort', clearTimerOnAbort, { once: true });
      cleanupAbortTimer = () => opts.signal?.removeEventListener('abort', clearTimerOnAbort);
    },
    onStdout: (chunk) => {
      output += chunk;
      opts.onProgress(chunk);
    },
    onStderr: (chunk) => {
      stderrOutput += chunk;
    },
    onClose: (code) => {
      clearProcessGuards();
      return { output, code: code ?? 1, timedOut, stderr: stderrOutput };
    },
    onError: (err) => {
      clearProcessGuards();
      if (opts.notFoundMessage && isENOENT(err)) return processError.notFound(opts.command, opts.notFoundMessage);
      return null;
    },
  });
}

export async function spawnWithShellFallback(opts: SpawnOptions): Promise<SpawnResult> {
  const { notFoundMessage: _drop, ...firstAttemptOpts } = opts;
  void _drop;
  try {
    return await spawnWithTimeout(firstAttemptOpts);
  } catch (err: unknown) {
    if (!isENOENT(err)) throw err;

    const userShell = process.env['SHELL'] ?? '/bin/bash';
    const fullCommand = [opts.command, ...opts.args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    return spawnWithTimeout({ ...opts, command: userShell, args: ['-lc', fullCommand] });
  }
}

export async function spawnWithStdin(opts: {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string | undefined;
  onLine: (line: string) => void;
  onStderr?: ((chunk: string) => void) | undefined;
  notFoundMessage?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<{ text: string; stderrOutput: string; code: number }> {
  let rawText = '';
  let stderrOutput = '';
  const stdoutBuf = createLineBuffer(opts.onLine);

  return spawnPipe({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    stdin: opts.stdin,
    signal: opts.signal,
    onStdout: (chunk) => {
      rawText += chunk;
      stdoutBuf.push(chunk);
    },
    onStderr: (chunk) => {
      stderrOutput += chunk;
      opts.onStderr?.(chunk);
    },
    onError: (err) => isENOENT(err) ? processError.notFound(opts.command, opts.notFoundMessage) : null,
    onClose: (code) => {
      stdoutBuf.flush();

      if (code === 127) {
        throw processError.notFound(opts.command, opts.notFoundMessage);
      }

      if (code !== 0) {
        throw processError.exitCode({
          command: opts.command,
          code,
          stderr: stderrOutput,
          output: rawText,
        });
      }

      return { text: rawText, stderrOutput, code: code ?? 0 };
    },
  });
}
