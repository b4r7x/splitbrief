import { spawn, type ChildProcess } from 'node:child_process';
import { isENOENT, isNodeError, CommandNotFoundError } from './process-errors.js';
import { redactSecrets } from './redact.js';


const SIGKILL_DELAY = 2000;
const ABORT_KILL_DELAY = 2000;

const activeProcesses = new Set<ChildProcess>();

export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
}

export function unregisterProcess(proc: ChildProcess): void {
  activeProcesses.delete(proc);
}

export function getActiveProcessCount(): number {
  return activeProcesses.size;
}

export function killProcess(proc: ChildProcess, options?: { group?: boolean; killDelay?: number }): void {
  if (proc.exitCode !== null || proc.killed) return;
  const pid = proc.pid;
  const useGroup = options?.group && pid !== undefined;
  const delay = options?.killDelay ?? SIGKILL_DELAY;
  try {
    if (useGroup && pid !== undefined) {
      process.kill(-pid, 'SIGTERM');
    } else {
      proc.kill('SIGTERM');
    }
  } catch (err) {
    if (!(isNodeError(err) && err.code === 'ESRCH')) {
      throw err;
    }
  }
  setTimeout(() => {
    const currentPid = proc.pid;
    if (currentPid === undefined) return;
    try {
      process.kill(useGroup ? -currentPid : currentPid, 0);
      if (useGroup) {
        process.kill(-currentPid, 'SIGKILL');
      } else {
        proc.kill('SIGKILL');
      }
    } catch (err) {
      if (!(isNodeError(err) && err.code === 'ESRCH')) {
        throw err;
      }
    }
  }, delay);
}

export function abortProcess(proc: ChildProcess, signal: AbortSignal): void {
  if (proc.exitCode !== null || proc.killed) return;

  const onAbort = () => killProcess(proc, { group: true, killDelay: ABORT_KILL_DELAY });

  if (signal.aborted) {
    onAbort();
    return;
  }

  signal.addEventListener('abort', onAbort, { once: true });
  proc.on('close', () => signal.removeEventListener('abort', onAbort));
}

export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    killProcess(proc);
  }
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export function createLineBuffer(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (buffer) { onLine(buffer); buffer = ''; }
    },
  };
}

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

function spawnPipe<T>(opts: SpawnPipeOptions<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    let proc: ChildProcess;
    try {
      proc = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: opts.detached ?? false,
      });
    } catch (err: unknown) {
      reject(err);
      return;
    }

    registerProcess(proc);
    opts.onSpawned?.(proc);

    if (opts.signal) {
      abortProcess(proc, opts.signal);
    }

    const { stdout, stderr, stdin } = proc;
    if (!stdout || !stderr || !stdin) {
      reject(new Error('Process streams not available'));
      return;
    }

    stdout.on('data', (chunk: Buffer) => opts.onStdout(chunk.toString()));
    stderr.on('data', (chunk: Buffer) => opts.onStderr(chunk.toString()));

    proc.on('error', (err: NodeJS.ErrnoException) => {
      unregisterProcess(proc);
      const mapped = opts.onError?.(err);
      reject(mapped ?? err);
    });

    proc.on('close', (code, signal) => {
      unregisterProcess(proc);
      try {
        Promise.resolve(opts.onClose(code, signal)).then(resolve, reject);
      } catch (err: unknown) {
        reject(err);
      }
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
    },
    onStdout: (chunk) => {
      output += chunk;
      opts.onProgress(chunk);
    },
    onStderr: (chunk) => {
      stderrOutput += chunk;
    },
    onClose: (code) => {
      if (timer !== null) clearTimeout(timer);
      return { output, code: code ?? 1, timedOut, stderr: stderrOutput };
    },
    onError: (err) => {
      if (timer !== null) clearTimeout(timer);
      if (opts.notFoundMessage && isENOENT(err)) return new CommandNotFoundError(opts.notFoundMessage);
      return null;
    },
  });
}

export async function spawnWithShellFallback(opts: SpawnOptions): Promise<SpawnResult> {
  // Strip notFoundMessage for the first attempt — let raw ENOENT propagate
  // so we can detect it and try the shell fallback.
  const { notFoundMessage, ...firstAttemptOpts } = opts;
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
  notFoundMessage: string;
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
    onError: (err) => isENOENT(err) ? new CommandNotFoundError(opts.notFoundMessage) : null,
    onClose: (code) => {
      stdoutBuf.flush();

      if (code === 127) {
        throw new CommandNotFoundError(opts.notFoundMessage);
      }

      if (code !== 0 && !rawText) {
        const detail = stderrOutput.trim();
        throw new Error(
          redactSecrets(`${opts.command} exited with code ${code}${detail ? `: ${detail}` : ''}`),
        );
      }

      return { text: rawText, stderrOutput, code: code ?? 0 };
    },
  });
}
