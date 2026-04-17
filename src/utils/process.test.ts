import { describe, it, expect } from 'vitest';
import { runCommand, spawnWithTimeout, spawnWithStdin } from './process.js';
import { killProcess, getActiveProcessCount } from './process-registry.js';
import { isENOENT, createProcessError } from './process-errors.js';
import { spawn } from 'node:child_process';
describe('runCommand', () => {
  it('resolves with stdout, stderr, and exit code', async () => {
    const result = await runCommand('echo', ['hello']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.code).toBe(0);
  });

  it('rejects with error for nonexistent command (ENOENT) without leaking timer', async () => {
    await expect(
      runCommand('nonexistent-command-that-does-not-exist-xyz', []),
    ).rejects.toMatchObject({ code: 'ENOENT' });
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

describe('spawnWithTimeout', () => {
  it('captures stdout and returns exit code 0', async () => {
    const chunks: string[] = [];
    const result = await spawnWithTimeout({
      command: 'echo',
      args: ['hello world'],
      cwd: process.cwd(),
      timeout: 5000,
      onProgress: (text) => chunks.push(text),
    });

    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('hello world');
    expect(chunks.join('')).toContain('hello world');
  });

  it('captures stderr', async () => {
    const result = await spawnWithTimeout({
      command: 'node',
      args: ['-e', 'console.error("err")'],
      cwd: process.cwd(),
      timeout: 5000,
      onProgress: () => {},
    });

    expect(result.stderr).toContain('err');
  });

  it('times out long-running processes', async () => {
    const result = await spawnWithTimeout({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      cwd: process.cwd(),
      timeout: 100,
      onProgress: () => {},
    });

    expect(result.timedOut).toBe(true);
  });

  it('writes stdinInput when provided', async () => {
    const result = await spawnWithTimeout({
      command: 'node',
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd: process.cwd(),
      timeout: 5000,
      onProgress: () => {},
      stdinInput: 'from stdin',
    });

    expect(result.code).toBe(0);
    expect(result.output).toContain('from stdin');
  });

  it('rejects on ENOENT for non-existent command', async () => {
    await expect(
      spawnWithTimeout({
        command: 'nonexistent-cmd-xyz-99999',
        args: [],
        cwd: process.cwd(),
        timeout: 5000,
        onProgress: () => {},
      }),
    ).rejects.toThrow();
  });
});

describe('createProcessError', () => {
  it('creates an Error with output property', () => {
    const err = createProcessError('something failed', 'partial output');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('something failed');
    expect(err.output).toBe('partial output');
  });
});

describe('spawnWithStdin', () => {
  it('captures stdout from a simple command', async () => {
    const lines: string[] = [];
    const result = await spawnWithStdin({
      command: 'echo',
      args: ['hello world'],
      cwd: '.',
      notFoundMessage: 'echo not found',
      onLine: (line) => lines.push(line),
    });

    expect(result.text).toContain('hello world');
    expect(result.code).toBe(0);
    expect(lines.some(l => l.includes('hello world'))).toBe(true);
  });

  it('writes stdin to process', async () => {
    const lines: string[] = [];
    const result = await spawnWithStdin({
      command: 'node',
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd: '.',
      stdin: 'piped input',
      notFoundMessage: 'cat not found',
      onLine: (line) => lines.push(line),
    });

    expect(result.text).toContain('piped input');
    expect(lines.some(l => l.includes('piped input'))).toBe(true);
  });

  it('captures stderr', async () => {
    const stderrChunks: string[] = [];
    const result = await spawnWithStdin({
      command: 'node',
      args: ['-e', 'process.stderr.write("err msg")'],
      cwd: '.',
      notFoundMessage: 'node not found',
      onLine: () => {},
      onStderr: (chunk) => stderrChunks.push(chunk),
    });

    expect(result.stderrOutput).toContain('err msg');
    expect(stderrChunks.join('')).toContain('err msg');
  });

  it('rejects with notFoundMessage for missing command', async () => {
    await expect(
      spawnWithStdin({
        command: 'nonexistent-cmd-xyz-99999',
        args: [],
        cwd: '.',
        notFoundMessage: 'Command not found!',
        onLine: () => {},
      }),
    ).rejects.toThrow('Command not found!');
  });

  it('rejects on non-zero exit with no stdout', async () => {
    await expect(
      spawnWithStdin({
        command: 'node',
        args: ['-e', 'process.exit(1)'],
        cwd: '.',
        notFoundMessage: 'node not found',
        onLine: () => {},
      }),
    ).rejects.toThrow('exited with code 1');
  });

  it('resolves with non-zero exit when stdout has content', async () => {
    const result = await spawnWithStdin({
      command: 'node',
      args: ['-e', 'process.stdout.write("output"); process.exit(1)'],
      cwd: '.',
      notFoundMessage: 'node not found',
      onLine: () => {},
    });

    expect(result.text).toContain('output');
    expect(result.code).toBe(1);
  });
});

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
