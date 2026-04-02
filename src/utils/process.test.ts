import { describe, it, expect } from 'vitest';
import { runCommand, spawnWithStreaming, killProcess, isENOENT, getActiveProcessCount } from './process.js';
import { spawn } from 'node:child_process';

describe('runCommand', () => {
  it('resolves with stdout, stderr, and exit code', async () => {
    const result = await runCommand('echo', ['hello']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.code).toBe(0);
  });

  it('rejects with error for nonexistent command (ENOENT) without leaking timer', async () => {
    // Before the fix, the timer was not cleared on spawn error, causing a leak.
    // The fix hoists the timer declaration and clears it in the error handler.
    await expect(
      runCommand('nonexistent-command-that-does-not-exist-xyz', []),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    // After rejection, the process should be cleaned up from activeProcesses
    // (there's no reliable way to check the timer itself, but the process set
    // should not accumulate dead entries)
  });

  it('does not leave process in activeProcesses after completion', async () => {
    const sizeBefore = getActiveProcessCount();
    await runCommand('echo', ['test']);
    expect(getActiveProcessCount()).toBe(sizeBefore);
  });

  it('does not leave process in activeProcesses after error', async () => {
    const sizeBefore = getActiveProcessCount();
    try {
      await runCommand('nonexistent-command-that-does-not-exist-xyz', []);
    } catch {}
    expect(getActiveProcessCount()).toBe(sizeBefore);
  });

  it('ENOENT rejection completes quickly without dangling timer', async () => {
    const start = Date.now();
    try {
      await runCommand('nonexistent-command-that-does-not-exist-xyz', [], { timeout: 60_000 });
    } catch {}
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('captures stderr output', async () => {
    const result = await runCommand('node', ['-e', 'console.error("oops")']);
    expect(result.stderr).toContain('oops');
    expect(result.code).toBe(0);
  });

  it('returns nonzero exit code on failure', async () => {
    const result = await runCommand('node', ['-e', 'process.exit(42)']);
    expect(result.code).toBe(42);
  });
});

describe('spawnWithStreaming', () => {
  it('streams stdout lines to callback', async () => {
    const lines: string[] = [];
    const result = await spawnWithStreaming('echo', ['line1'], (line) => lines.push(line));
    expect(result.code).toBe(0);
    expect(lines.some((l) => l.includes('line1'))).toBeTruthy();
  });

  it('cleans up from activeProcesses after completion', async () => {
    const sizeBefore = getActiveProcessCount();
    await spawnWithStreaming('echo', ['test'], () => {});
    expect(getActiveProcessCount()).toBe(sizeBefore);
  });

  it('does not leave ghost entry in activeProcesses after ENOENT', async () => {
    const sizeBefore = getActiveProcessCount();
    try {
      await spawnWithStreaming('nonexistent-command-that-does-not-exist-xyz', [], () => {});
    } catch {}
    expect(getActiveProcessCount()).toBe(sizeBefore);
  });
});

describe('killProcess', () => {
  it('kills a long-running process', async () => {
    const proc = spawn('sleep', ['60'], { stdio: 'ignore' });
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

describe('isENOENT', () => {
  it('returns true for ENOENT errors', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    expect(isENOENT(err)).toBe(true);
  });

  it('returns false for other errors', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(isENOENT(err)).toBe(false);
  });

  it('returns false for non-Error objects', () => {
    expect(isENOENT('ENOENT')).toBe(false);
    expect(isENOENT(null)).toBe(false);
    expect(isENOENT(undefined)).toBe(false);
  });
});
