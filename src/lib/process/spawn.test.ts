import { describe, it, expect } from 'vitest';
import { runCommand, spawnWithTimeout, spawnWithStdin, spawnError } from './spawn.js';
import { killProcess } from './registry.js';
import { isENOENT, processError } from './errors.js';
import { spawn } from 'node:child_process';

describe('spawnError', () => {
  it('tags the unavailable-streams failure with a domain kind', () => {
    const err = spawnError.streamsUnavailable();
    expect(err.kind).toBe('process-streams-unavailable');
    expect(err.message).toBe('Process streams not available');
  });
});

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

  it('retains bounded stdout and stderr snapshots for large command output', async () => {
    const result = await runCommand(
      'node',
      [
        '-e',
        ['process.stdout.write("a".repeat(80));', 'process.stderr.write("b".repeat(80));'].join(''),
      ],
      { outputMaxBytes: 20, stderrMaxBytes: 10 },
    );

    expect(result.stdout).toHaveLength(20);
    expect(result.stderr).toHaveLength(10);
    expect(result.stdoutMetadata).toMatchObject({
      bytesSeen: 80,
      bytesStored: 20,
      omittedBytes: 80,
      truncated: true,
      policy: 'prefix-tail',
    });
    expect(result.stderrMetadata).toMatchObject({
      bytesSeen: 80,
      bytesStored: 10,
      omittedBytes: 80,
      truncated: true,
      policy: 'tail',
    });
  });

  it('rejects with a process-output error on nonzero exit', async () => {
    await expect(runCommand('node', ['-e', 'process.exit(42)'])).rejects.toMatchObject({
      kind: 'process-output',
    });
  });

  it('rejects with a timeout-kinded error when the command exceeds the timeout', async () => {
    await expect(
      runCommand('node', ['-e', 'setTimeout(() => {}, 10_000)'], { timeout: 100 }),
    ).rejects.toMatchObject({ kind: 'command-timeout' });
  });

  it('uses the provided label in the timeout message', async () => {
    await expect(
      runCommand('node', ['-e', 'setTimeout(() => {}, 10_000)'], {
        timeout: 100,
        label: 'typecheck validation',
      }),
    ).rejects.toThrow('typecheck validation timed out');
  });

  it('caps retained stdout and reports truncation metadata', async () => {
    const result = await runCommand(
      'node',
      ['-e', 'process.stdout.write("A".repeat(1024 * 1024 + 100))'],
      { outputMaxBytes: 1024 },
    );

    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1024);
    expect(result.stdout).toContain('output truncated');
    expect(result.stdoutMetadata).toMatchObject({
      bytesSeen: 1024 * 1024 + 100,
      maxBytes: 1024,
      truncated: true,
    });
  });

  it('uses bounded stderr and stdout in process-output errors', async () => {
    try {
      await runCommand(
        'node',
        [
          '-e',
          [
            'process.stdout.write("O".repeat(100_000));',
            'process.stderr.write("E".repeat(100_000));',
            'process.exit(2);',
          ].join(''),
        ],
        { outputMaxBytes: 512, stderrMaxBytes: 256 },
      );
      throw new Error('expected command to fail');
    } catch (err: unknown) {
      expect(processError.isExitCode(err)).toBe(true);
      if (!processError.isExitCode(err)) return;
      expect(Buffer.byteLength(err.data.output, 'utf8')).toBeLessThanOrEqual(512);
      expect(Buffer.byteLength(err.data.stderr, 'utf8')).toBeLessThanOrEqual(256);
      expect(err.data.output).toContain('output truncated');
      expect(err.data.stderr).toContain('output truncated');
    }
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
    const stderrChunks: string[] = [];
    const result = await spawnWithTimeout({
      command: 'node',
      args: ['-e', 'console.error("err")'],
      cwd: process.cwd(),
      timeout: 5000,
      onProgress: () => {},
      onStderr: (chunk) => stderrChunks.push(chunk),
    });

    expect(result.stderr).toContain('err');
    expect(stderrChunks.join('')).toContain('err');
  });

  it('streams every stdout chunk while retaining only bounded output', async () => {
    const chunks: string[] = [];
    const result = await spawnWithTimeout({
      command: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(100))'],
      cwd: process.cwd(),
      timeout: 5000,
      outputMaxBytes: 12,
      onProgress: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join('')).toHaveLength(100);
    expect(result.output).toHaveLength(12);
    expect(result.outputMetadata).toMatchObject({
      bytesSeen: 100,
      bytesStored: 12,
      omittedBytes: 100,
      truncated: true,
    });
  });

  it('caps retained output while still forwarding progress chunks', async () => {
    let progressBytes = 0;
    const result = await spawnWithTimeout({
      command: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(100_000))'],
      cwd: process.cwd(),
      timeout: 5000,
      outputMaxBytes: 1024,
      onProgress: (chunk) => {
        progressBytes += Buffer.byteLength(chunk, 'utf8');
      },
    });

    expect(progressBytes).toBe(100_000);
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(1024);
    expect(result.outputMetadata).toMatchObject({
      bytesSeen: 100_000,
      maxBytes: 1024,
      truncated: true,
    });
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

  it('rejects with a process-output error on nonzero exit when not timed out', async () => {
    await expect(
      spawnWithTimeout({
        command: 'node',
        args: ['-e', 'process.exit(3)'],
        cwd: process.cwd(),
        timeout: 5000,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ kind: 'process-output' });
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

  it('reassembles multibyte stdout split across data chunks without corruption', async () => {
    // The child writes each UTF-8 byte of '日本語' in its own write, forcing the parent stream
    // to receive multibyte characters split across data events. With setEncoding('utf8') the
    // partial sequences buffer until complete, so the decoded output must be lossless.
    const program = [
      'const bytes = Buffer.from("日本語", "utf8");',
      'let i = 0;',
      'const tick = () => {',
      '  if (i >= bytes.length) return;',
      '  process.stdout.write(bytes.subarray(i, i + 1));',
      '  i += 1;',
      '  setTimeout(tick, 1);',
      '};',
      'tick();',
    ].join('');

    const result = await spawnWithTimeout({
      command: 'node',
      args: ['-e', program],
      cwd: process.cwd(),
      timeout: 5000,
      onProgress: () => {},
    });

    expect(result.code).toBe(0);
    expect(result.output).toBe('日本語');
    expect(result.output).not.toContain('�');
  });

  it('rejects with AbortError when aborted after output', async () => {
    const controller = new AbortController();
    const chunks: string[] = [];
    let resolveOutput: () => void = () => {};
    const outputSeen = new Promise<void>((resolve) => {
      resolveOutput = resolve;
    });
    const promise = spawnWithTimeout({
      command: 'node',
      args: ['-e', 'console.log("before abort"); setTimeout(() => {}, 10_000)'],
      cwd: process.cwd(),
      timeout: 5_000,
      onProgress: (text) => {
        chunks.push(text);
        resolveOutput();
      },
      signal: controller.signal,
    });

    await outputSeen;
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(chunks.join('')).toContain('before abort');
  });

  it('resolves abort promptly without waiting for timeout', async () => {
    const controller = new AbortController();
    let resolveOutput: () => void = () => {};
    const outputSeen = new Promise<void>((resolve) => {
      resolveOutput = resolve;
    });

    const start = Date.now();
    const promise = spawnWithTimeout({
      command: 'node',
      args: ['-e', 'console.log("before abort"); setTimeout(() => {}, 10_000)'],
      cwd: process.cwd(),
      timeout: 60_000,
      onProgress: () => resolveOutput(),
      signal: controller.signal,
    });

    await outputSeen;
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - start).toBeLessThan(5_000);
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
    expect(lines.some((l) => l.includes('hello world'))).toBe(true);
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
    expect(lines.some((l) => l.includes('piped input'))).toBe(true);
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

  it('retains bounded stdout and stderr while line parsing still receives safe lines', async () => {
    const lines: string[] = [];
    const stderrChunks: string[] = [];
    const result = await spawnWithStdin({
      command: 'node',
      args: [
        '-e',
        [
          'process.stdout.write("line1\\n");',
          'process.stdout.write("x".repeat(80));',
          'process.stderr.write("e".repeat(80));',
        ].join(''),
      ],
      cwd: '.',
      onLine: (line) => lines.push(line),
      onStderr: (chunk) => stderrChunks.push(chunk),
      outputMaxBytes: 20,
      stderrMaxBytes: 10,
      stdoutLineMaxBytes: 16,
    });

    expect(lines).toEqual(['line1']);
    expect(stderrChunks.join('')).toHaveLength(80);
    expect(result.text).toHaveLength(20);
    expect(result.stderrOutput).toHaveLength(10);
    expect(result.textMetadata).toMatchObject({
      bytesSeen: 86,
      bytesStored: 20,
      omittedBytes: 86,
      truncated: true,
    });
    expect(result.stderrMetadata).toMatchObject({
      bytesSeen: 80,
      bytesStored: 10,
      omittedBytes: 80,
      truncated: true,
    });
  });

  it('caps retained text and prevents an oversized partial stdout line from being emitted', async () => {
    const lines: string[] = [];
    const result = await spawnWithStdin({
      command: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(100_000))'],
      cwd: '.',
      notFoundMessage: 'node not found',
      outputMaxBytes: 1024,
      stdoutLineMaxBytes: 512,
      onLine: (line) => lines.push(line),
    });

    expect(lines).toEqual([]);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(1024);
    expect(result.textMetadata).toMatchObject({
      bytesSeen: 100_000,
      maxBytes: 1024,
      truncated: true,
    });
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

  it('rejects on non-zero exit even when stdout has content', async () => {
    await expect(
      spawnWithStdin({
        command: 'node',
        args: ['-e', 'process.stdout.write("output"); process.exit(1)'],
        cwd: '.',
        notFoundMessage: 'node not found',
        onLine: () => {},
      }),
    ).rejects.toMatchObject({
      kind: 'process-output',
      data: expect.objectContaining({ output: 'output' }),
    });
  });

  it('rejects with AbortError when aborted after stdout', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    let resolveLine: () => void = () => {};
    const lineSeen = new Promise<void>((resolve) => {
      resolveLine = resolve;
    });
    const promise = spawnWithStdin({
      command: 'node',
      args: ['-e', 'console.log("before abort"); setTimeout(() => {}, 10_000)'],
      cwd: '.',
      notFoundMessage: 'node not found',
      onLine: (line) => {
        lines.push(line);
        resolveLine();
      },
      signal: controller.signal,
    });

    await lineSeen;
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(lines).toContain('before abort');
  });

  it('kills the whole process group on abort so grandchildren are not orphaned', async () => {
    const controller = new AbortController();
    let resolveGrandchild: (pid: number) => void = () => {};
    const grandchildPid = new Promise<number>((resolve) => {
      resolveGrandchild = resolve;
    });

    // The child detaches a long-lived grandchild and prints its PID. Without group
    // teardown the grandchild would survive the parent's death and leak; detached+group
    // SIGTERM reaches the entire group, so the grandchild must die with the parent.
    const childProgram = [
      "const { spawn } = require('node:child_process');",
      "const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });",
      'process.stdout.write(String(gc.pid) + "\\n");',
      'setTimeout(() => {}, 60_000);',
    ].join('');

    const promise = spawnWithStdin({
      command: 'node',
      args: ['-e', childProgram],
      cwd: '.',
      notFoundMessage: 'node not found',
      onLine: (line) => {
        const pid = Number.parseInt(line.trim(), 10);
        if (Number.isInteger(pid)) resolveGrandchild(pid);
      },
      signal: controller.signal,
    });

    const pid = await grandchildPid;
    expect(pid).toBeGreaterThan(0);

    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    const stillAlive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const deadline = Date.now() + 5000;
    while (stillAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(stillAlive()).toBe(false);
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
