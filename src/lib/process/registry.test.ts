import { spawn } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { killAllProcesses, registerProcess, unregisterProcess } from './registry.js';

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

  it('kills detached process groups when registered with group metadata', async () => {
    const proc = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    procs.push(proc);
    registerProcess(proc, { group: true });

    killAllProcesses();

    let closed = false;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('process did not exit')), 3000);
      proc.once('close', () => {
        closed = true;
        clearTimeout(timer);
        resolve();
      });
    });

    expect(closed).toBe(true);
    expect(proc.signalCode === 'SIGTERM' || proc.exitCode !== null).toBe(true);
  });
});
