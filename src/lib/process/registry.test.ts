import { spawn } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { killAllProcesses, killProcess, registerProcess, unregisterProcess } from './registry.js';

describe('killAllProcesses', () => {
  const procs: ReturnType<typeof spawn>[] = [];

  afterEach(() => {
    killAllProcesses();
    for (const proc of procs) {
      unregisterProcess(proc);
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    procs.length = 0;
  });

  const waitForClose = (proc: ReturnType<typeof spawn>) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('process did not exit')), 3000);
      proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

  it('kills detached process groups when registered with group metadata', async () => {
    const proc = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    procs.push(proc);
    registerProcess(proc, { group: true });

    killAllProcesses();
    await waitForClose(proc);

    expect(proc.signalCode === 'SIGTERM' || proc.exitCode !== null).toBe(true);
  });

  it('reaps every in-flight registered child in one sweep', async () => {
    const grouped = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const plain = spawn('sleep', ['60'], { stdio: 'ignore' });
    procs.push(grouped, plain);
    registerProcess(grouped, { group: true });
    registerProcess(plain);

    killAllProcesses();
    await Promise.all([waitForClose(grouped), waitForClose(plain)]);

    expect(grouped.signalCode === 'SIGTERM' || grouped.exitCode !== null).toBe(true);
    expect(plain.signalCode === 'SIGTERM' || plain.exitCode !== null).toBe(true);
  });

  it('warns instead of crashing when SIGKILL escalation throws a non-ESRCH error', async () => {
    const proc = spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready");',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    procs.push(proc);
    await new Promise<void>((resolve) => {
      proc.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) resolve();
      });
    });

    const realKill = proc.kill.bind(proc);
    proc.kill = ((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGKILL') {
        const fatal: NodeJS.ErrnoException = new Error('kill EPERM');
        fatal.code = 'EPERM';
        throw fatal;
      }
      return realKill(signal);
    }) as typeof proc.kill;

    const warnings: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      warnings.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      killProcess(proc, { killDelay: 20 });
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
    } finally {
      process.stderr.write = originalStderrWrite;
      proc.kill = realKill;
      realKill('SIGKILL');
    }

    expect(warnings.join('')).toContain('kill EPERM');
  });
});
