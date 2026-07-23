import { describe, it, expect, vi } from 'vitest';
import { spawnWithTimeout } from './progress.js';
import { spawnWithStdin } from './line-stream.js';

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

describe('idle watchdog', () => {
  it('idle kill terminates the process group and surfaces command-idle-timeout', async () => {
    vi.useFakeTimers();
    try {
      let resolveGrandchild: (pid: number) => void = () => {};
      const grandchildPid = new Promise<number>((resolve) => {
        resolveGrandchild = resolve;
      });

      // The child detaches a long-lived grandchild and prints its PID, then goes
      // silent; the idle kill must take down the entire group, not just the child.
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
        onLine: (line) => {
          const pid = Number.parseInt(line.trim(), 10);
          if (Number.isInteger(pid)) resolveGrandchild(pid);
        },
        idle: { warnMs: 500, killMs: 1_000 },
      });
      const settled = expect(promise).rejects.toMatchObject({ kind: 'command-idle-timeout' });

      const pid = await grandchildPid;
      vi.advanceTimersByTime(1_000);
      vi.useRealTimers();
      await settled;

      const stillAlive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 5_000;
      while (stillAlive() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(stillAlive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('output chunks reset the idle timers', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const onWarn = vi.fn();
      let sawOutput: () => void = () => {};
      const outputSeen = new Promise<void>((resolve) => {
        sawOutput = resolve;
      });

      const promise = spawnWithTimeout({
        command: 'node',
        args: [
          '-e',
          'setTimeout(() => { process.stdout.write("tick\\n"); setTimeout(() => {}, 60_000); }, 50)',
        ],
        cwd: process.cwd(),
        timeout: 600_000,
        onProgress: () => sawOutput(),
        signal: controller.signal,
        idle: { warnMs: 1_000, killMs: 600_000, onWarn },
      });
      const settled = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

      vi.advanceTimersByTime(600);
      await outputSeen;
      vi.advanceTimersByTime(600);
      expect(onWarn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(400);
      expect(onWarn).toHaveBeenCalledWith(1_000);

      controller.abort();
      vi.useRealTimers();
      await settled;
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });

  it('onWarn fires once per silence episode and onClear fires on the next output', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const onWarn = vi.fn();
      const onClear = vi.fn();
      let sawFirst: () => void = () => {};
      const firstSeen = new Promise<void>((resolve) => {
        sawFirst = resolve;
      });
      let sawSecond: () => void = () => {};
      const secondSeen = new Promise<void>((resolve) => {
        sawSecond = resolve;
      });

      const childProgram = [
        'process.stdout.write("one\\n");',
        'setTimeout(() => { process.stdout.write("two\\n"); }, 400);',
        'setTimeout(() => {}, 60_000);',
      ].join('');

      const promise = spawnWithStdin({
        command: 'node',
        args: ['-e', childProgram],
        cwd: '.',
        onLine: (line) => {
          if (line === 'one') sawFirst();
          if (line === 'two') sawSecond();
        },
        signal: controller.signal,
        idle: { warnMs: 1_000, killMs: 600_000, onWarn, onClear },
      });
      const settled = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

      await firstSeen;
      vi.advanceTimersByTime(1_000);
      expect(onWarn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(3_000);
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(onClear).not.toHaveBeenCalled();

      await secondSeen;
      expect(onClear).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1_000);
      expect(onWarn).toHaveBeenCalledTimes(2);

      controller.abort();
      vi.useRealTimers();
      await settled;
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });

  it('output after the idle kill fires does not emit onClear or re-arm timers', async () => {
    vi.useFakeTimers();
    try {
      const onWarn = vi.fn();
      const onClear = vi.fn();
      let resolveReady: () => void = () => {};
      const readySeen = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      let resolveLate: () => void = () => {};
      const lateSeen = new Promise<void>((resolve) => {
        resolveLate = resolve;
      });

      // Ignores SIGTERM so the idle-kill grace window stays open long enough to
      // flush one more line, then self-exits like a dying runner finally giving up.
      const childProgram = [
        "process.on('SIGTERM', () => {});",
        "process.stdout.write('ready\\n');",
        'setTimeout(() => {',
        "  process.stdout.write('late\\n');",
        '  setTimeout(() => process.exit(0), 20);',
        '}, 50);',
        'setTimeout(() => {}, 60_000);',
      ].join('');

      const promise = spawnWithStdin({
        command: 'node',
        args: ['-e', childProgram],
        cwd: '.',
        onLine: (line) => {
          if (line === 'ready') resolveReady();
          if (line === 'late') resolveLate();
        },
        idle: { warnMs: 500, killMs: 1_000, onWarn, onClear },
      });
      const settled = expect(promise).rejects.toMatchObject({ kind: 'command-idle-timeout' });

      await readySeen;
      vi.advanceTimersByTime(1_000);
      expect(onWarn).toHaveBeenCalledTimes(1);

      await lateSeen;
      expect(onClear).not.toHaveBeenCalled();

      vi.advanceTimersByTime(500);
      expect(onWarn).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
