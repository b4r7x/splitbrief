import { spawn, type ChildProcess } from 'node:child_process';

const SIGKILL_DELAY = 5000;

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

const activeProcesses = new Set<ChildProcess>();

export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
}

export function unregisterProcess(proc: ChildProcess): void {
  activeProcesses.delete(proc);
}

/** @internal Exported for testing only. */
export function getActiveProcessCount(): number {
  return activeProcesses.size;
}

export function killProcess(proc: ChildProcess, options?: { group?: boolean }): void {
  if (proc.exitCode !== null || proc.killed) return;
  const useGroup = options?.group && proc.pid !== undefined;
  try {
    if (useGroup) {
      process.kill(-proc.pid!, 'SIGTERM');
    } else {
      proc.kill('SIGTERM');
    }
  } catch {}
  setTimeout(() => {
    if (proc.pid === undefined) return;
    try {
      process.kill(useGroup ? -proc.pid! : proc.pid, 0);
      if (useGroup) {
        process.kill(-proc.pid!, 'SIGKILL');
      } else {
        proc.kill('SIGKILL');
      }
    } catch {}
  }, SIGKILL_DELAY);
}

function spawnManaged<T>(
  command: string,
  args: string[],
  cwd: string | undefined,
  setup: (proc: ChildProcess) => {
    onClose: (code: number | null, signal: string | null) => T;
    onError?: (err: Error) => void;
  },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    registerProcess(proc);

    const { onClose, onError } = setup(proc);

    proc.on('error', (err) => {
      onError?.(err);
      unregisterProcess(proc);
      reject(err);
    });

    proc.on('close', (code, signal) => {
      unregisterProcess(proc);
      resolve(onClose(code, signal));
    });
  });
}

export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string | undefined; timeout?: number | undefined },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeout = options?.timeout ?? 60_000;

  return spawnManaged(command, args, options?.cwd, (proc) => {
    const timer = setTimeout(() => killProcess(proc), timeout);

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    return {
      onError: () => clearTimeout(timer),
      onClose: (code) => {
        clearTimeout(timer);
        return { stdout, stderr, code: code ?? 1 };
      },
    };
  });
}

export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    killProcess(proc);
  }
}

export function isENOENT(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
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
}

export function spawnWithTimeout(opts: SpawnOptions): Promise<SpawnResult> {
  const { command, args, cwd, timeout, onProgress, stdinInput } = opts;
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err: unknown) {
      reject(err);
      return;
    }

    registerProcess(proc);

    let output = '';
    let stderrOutput = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcess(proc, { group: true });
    }, timeout);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      onProgress(text);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      unregisterProcess(proc);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      unregisterProcess(proc);
      resolve({ output, code: code ?? 1, timedOut, stderr: stderrOutput });
    });

    if (stdinInput !== undefined) {
      proc.stdin?.write(stdinInput);
    }
    proc.stdin?.end();
  });
}

export async function spawnWithShellFallback(opts: SpawnOptions): Promise<SpawnResult> {
  try {
    return await spawnWithTimeout(opts);
  } catch (err: unknown) {
    if (!isENOENT(err)) throw err;

    const userShell = process.env['SHELL'] ?? '/bin/bash';
    const fullCommand = [opts.command, ...opts.args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    return spawnWithTimeout({ ...opts, command: userShell, args: ['-lc', fullCommand] });
  }
}

export function createProcessError(message: string, output: string): Error & { output: string } {
  const err = new Error(message) as Error & { output: string };
  err.output = output;
  return err;
}

export async function spawnWithStdin(opts: {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string | undefined;
  onLine: (line: string) => void;
  onStderr?: ((chunk: string) => void) | undefined;
  notFoundMessage: string;
}): Promise<{ text: string; stderrOutput: string; code: number }> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(opts.command, opts.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd,
      });
    } catch (err: unknown) {
      if (isENOENT(err)) {
        reject(new Error(opts.notFoundMessage));
        return;
      }
      reject(err);
      return;
    }

    registerProcess(proc);

    let rawText = '';
    let stderrOutput = '';
    const stdoutBuf = createLineBuffer(line => opts.onLine(line));

    proc.on('error', (err: NodeJS.ErrnoException) => {
      unregisterProcess(proc);
      if (isENOENT(err)) {
        reject(new Error(opts.notFoundMessage));
      } else {
        reject(err);
      }
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      rawText += str;
      stdoutBuf.push(str);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrOutput += text;
      opts.onStderr?.(text);
    });

    proc.on('close', (code) => {
      unregisterProcess(proc);

      stdoutBuf.flush();

      if (code === 127) {
        reject(new Error(opts.notFoundMessage));
        return;
      }

      if (code !== 0 && !rawText) {
        const detail = stderrOutput.trim();
        reject(new Error(
          `${opts.command} exited with code ${code}${detail ? `: ${detail}` : ''}`,
        ));
        return;
      }

      resolve({ text: rawText, stderrOutput, code: code ?? 0 });
    });

    if (opts.stdin != null) {
      proc.stdin.write(opts.stdin);
    }
    proc.stdin.end();
  });
}
