import { describe, it, expect } from 'vitest';
import { spawnWithTimeout } from './progress.js';
import { setProcessLedger } from '../registry.js';

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

  it('ledger: false bypasses the runner-pid ledger', async () => {
    const recorded: number[] = [];
    const released: number[] = [];
    setProcessLedger({
      record: (pid) => recorded.push(pid),
      release: (pid) => released.push(pid),
    });
    try {
      await spawnWithTimeout({
        command: 'echo',
        args: ['hello'],
        cwd: process.cwd(),
        timeout: 5000,
        onProgress: () => {},
        ledger: false,
      });
    } finally {
      setProcessLedger(null);
    }

    expect(recorded).toEqual([]);
    expect(released).toEqual([]);
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
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('rejects with the install hint when a non-existent command has a notFoundMessage', async () => {
    await expect(
      spawnWithTimeout({
        command: 'nonexistent-cmd-xyz-99999',
        args: [],
        cwd: process.cwd(),
        timeout: 5000,
        onProgress: () => {},
        notFoundMessage: 'Install it with: npm i -g nonexistent-cmd-xyz-99999',
      }),
    ).rejects.toMatchObject({
      kind: 'command-not-found',
      message: 'Install it with: npm i -g nonexistent-cmd-xyz-99999',
    });
  }, 15_000);

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
