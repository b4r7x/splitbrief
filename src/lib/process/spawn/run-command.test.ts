import { describe, it, expect } from 'vitest';
import { runCommand } from './run-command.js';
import { setProcessLedger } from '../registry.js';
import { processError } from '../errors.js';

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

  it('kills the process group on timeout so descendants are not orphaned', async () => {
    const childProgram = 'sleep 60 & printf "%s\\n" "$!"; sleep 60';

    let descendantPid = 0;
    try {
      await runCommand('sh', ['-c', childProgram], { timeout: 1_000 });
      throw new Error('expected command to time out');
    } catch (err: unknown) {
      expect(processError.isTimeout(err)).toBe(true);
      if (!processError.isTimeout(err)) throw err;
      const data = err.data as { output?: string };
      descendantPid = Number.parseInt(data.output?.trim() ?? '', 10);
    }

    expect(descendantPid).toBeGreaterThan(0);

    const stillAlive = () => {
      try {
        process.kill(descendantPid, 0);
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

  it('runCommand spawns bypass the runner-pid ledger', async () => {
    const recorded: number[] = [];
    const released: number[] = [];
    setProcessLedger({
      record: (pid) => recorded.push(pid),
      release: (pid) => released.push(pid),
    });
    try {
      await runCommand('echo', ['hello']);
    } finally {
      setProcessLedger(null);
    }

    expect(recorded).toEqual([]);
    expect(released).toEqual([]);
  });
});
