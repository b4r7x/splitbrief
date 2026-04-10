import { describe, it, expect } from 'vitest';
import { killProcess } from './process-lifecycle.js';
import { spawn } from 'node:child_process';

describe('killProcess', () => {
  it('kills a long-running process', async () => {
    const proc = spawn('node', ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => {
      proc.on('spawn', resolve);
    });
    expect(proc.exitCode).toBe(null);
    killProcess(proc);
    await new Promise<void>((resolve) => {
      proc.on('close', () => resolve());
    });
    expect(proc.killed).toBeTruthy();
  });
});
