import { spawn, type ChildProcess } from 'node:child_process';

export const activeProcesses = new Set<ChildProcess>();

export function killProcess(proc: ChildProcess): void {
  if (proc.exitCode === null && !proc.killed) {
    proc.kill('SIGTERM');
  }
}

export function spawnWithStreaming(
  command: string,
  args: string[],
  onStdout: (line: string) => void,
  onStderr?: (line: string) => void,
  options?: { cwd?: string },
): Promise<{ code: number; killed: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.on('error', (err) => {
      activeProcesses.delete(proc);
      reject(err);
    });

    activeProcesses.add(proc);

    let stdoutBuffer = '';
    let stderrBuffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop()!;
      for (const line of lines) {
        onStdout(line);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop()!;
      for (const line of lines) {
        onStderr?.(line);
      }
    });

    proc.on('close', (code, signal) => {
      activeProcesses.delete(proc);

      if (stdoutBuffer) onStdout(stdoutBuffer);
      if (stderrBuffer) onStderr?.(stderrBuffer);

      resolve({
        code: code ?? (signal ? 1 : 0),
        killed: proc.killed || signal === 'SIGTERM' || signal === 'SIGINT',
      });
    });
  });
}

export function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const timeout = options?.timeout ?? 60_000;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.on('error', (err) => {
      activeProcesses.delete(proc);
      reject(err);
    });

    activeProcesses.add(proc);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      killProcess(proc);
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    killProcess(proc);
  }
}
