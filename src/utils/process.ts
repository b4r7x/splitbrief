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

export function spawnWithStreaming(
  command: string,
  args: string[],
  onStdout: (line: string) => void,
  onStderr?: (line: string) => void,
  options?: { cwd?: string },
): Promise<{ code: number; killed: boolean }> {
  return spawnManaged(command, args, options?.cwd, (proc) => {
    const stdoutBuf = createLineBuffer(line => onStdout(line));
    const stderrBuf = createLineBuffer(line => onStderr?.(line));

    proc.stdout!.on('data', (chunk: Buffer) => stdoutBuf.push(chunk.toString()));
    proc.stderr!.on('data', (chunk: Buffer) => stderrBuf.push(chunk.toString()));

    return {
      onClose: (code, signal) => {
        stdoutBuf.flush();
        stderrBuf.flush();
        return {
          code: code ?? (signal ? 1 : 0),
          killed: proc.killed || signal === 'SIGTERM' || signal === 'SIGINT',
        };
      },
    };
  });
}

export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
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
