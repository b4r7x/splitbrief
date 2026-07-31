import { describe, it, expect, vi } from 'vitest';
import { spawnWithTimeout } from './progress.js';
import { spawnWithStdin } from './line-stream.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

  it('rejects byte overflow with bounded partial stdout and stderr', async () => {
    const lines: string[] = [];
    const stderrChunks: string[] = [];
    let outcome: unknown;
    try {
      await spawnWithStdin({
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
    } catch (err) {
      outcome = err;
    }

    expect(lines).toEqual(['line1']);
    expect(outcome).toMatchObject({
      state: 'output-budget-breach',
      stdoutMetadata: {
        bytesSeen: 86,
        bytesStored: 20,
        omittedBytes: 86,
        truncated: true,
      },
      stderrMetadata: {
        maxBytes: 10,
      },
    });
  });

  it('caps retained text when byte overflow becomes fatal', async () => {
    const lines: string[] = [];
    let outcome: unknown;
    try {
      await spawnWithStdin({
        command: 'node',
        args: ['-e', 'process.stdout.write("x".repeat(100_000)); setInterval(() => {}, 60_000)'],
        cwd: '.',
        notFoundMessage: 'node not found',
        outputMaxBytes: 1024,
        stdoutLineMaxBytes: 512,
        onLine: (line) => lines.push(line),
      });
    } catch (err) {
      outcome = err;
    }

    expect(lines).toEqual([]);
    expect(outcome).toMatchObject({
      state: 'output-budget-breach',
      stdoutMetadata: {
        bytesSeen: 100_000,
        maxBytes: 1024,
        truncated: true,
      },
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

  it('reaps descendants before rejecting when the final-line callback throws', async () => {
    let descendantPid = 0;
    const callbackError = new Error('final-line callback failed');
    const childProgram = [
      "const { spawn } = require('node:child_process');",
      "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'ignore' });",
      'descendant.unref();',
      'process.stdout.write(String(descendant.pid) + ":unterminated");',
    ].join('');

    const promise = spawnWithStdin({
      command: process.execPath,
      args: ['-e', childProgram],
      cwd: '.',
      onLine: (line) => {
        descendantPid = Number.parseInt(line.split(':', 1)[0] ?? '', 10);
        throw callbackError;
      },
    });

    try {
      await expect(promise).rejects.toBe(callbackError);
      expect(descendantPid).toBeGreaterThan(1);

      const deadline = Date.now() + 5000;
      while (isProcessAlive(descendantPid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(isProcessAlive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid > 1 && isProcessAlive(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // The child may have exited between the liveness check and cleanup.
        }
      }
    }
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
    const controller = new AbortController();
    let promise: ReturnType<typeof spawnWithStdin> | undefined;
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

      promise = spawnWithStdin({
        command: 'node',
        args: ['-e', childProgram],
        cwd: '.',
        onLine: (line) => {
          const pid = Number.parseInt(line.trim(), 10);
          if (Number.isInteger(pid)) resolveGrandchild(pid);
        },
        signal: controller.signal,
        idle: { warnMs: 250, killMs: 500 },
      });

      const pid = await grandchildPid;
      await expect(promise).rejects.toMatchObject({ kind: 'command-idle-timeout' });

      expect(isProcessAlive(pid)).toBe(false);
    } finally {
      controller.abort();
      await promise?.catch(() => {});
    }
  });

  it('output chunks reset the idle timers', async () => {
    const controller = new AbortController();
    let promise: ReturnType<typeof spawnWithTimeout> | undefined;
    try {
      let childPid = 0;
      let resolveStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      let tickAt = 0;
      let resolveTick: () => void = () => {};
      const tickSeen = new Promise<void>((resolve) => {
        resolveTick = resolve;
      });
      let warnAt = 0;
      let resolveWarn: () => void = () => {};
      const onWarn = vi.fn(() => {
        warnAt = Date.now();
        resolveWarn();
      });

      const childProgram = [
        "process.stdout.write('started:' + process.pid + '\\n');",
        'setTimeout(() => process.stdout.write("tick\\n"), 100);',
        'setTimeout(() => {}, 60_000);',
      ].join('');

      promise = spawnWithTimeout({
        command: 'node',
        args: ['-e', childProgram],
        cwd: process.cwd(),
        timeout: 600_000,
        onProgress: (chunk) => {
          const match = /started:(\d+)/.exec(chunk);
          if (match?.[1] !== undefined) {
            childPid = Number.parseInt(match[1], 10);
            resolveStarted();
          }
          if (chunk.includes('tick')) {
            tickAt = Date.now();
            resolveTick();
          }
        },
        signal: controller.signal,
        idle: { warnMs: 300, killMs: 600_000, onWarn },
      });

      await started;
      onWarn.mockClear();
      const warned = new Promise<void>((resolve) => {
        resolveWarn = resolve;
      });
      await tickSeen;
      expect(onWarn).not.toHaveBeenCalled();

      await warned;
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(warnAt - tickAt).toBeGreaterThanOrEqual(250);

      controller.abort();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      controller.abort();
      await promise?.catch(() => {});
    }
  });

  it('onWarn fires once per silence episode and onClear fires on the next output', async () => {
    const controller = new AbortController();
    let promise: ReturnType<typeof spawnWithStdin> | undefined;
    try {
      let resolveWarn: () => void = () => {};
      const onWarn = vi.fn(() => resolveWarn());
      const onClear = vi.fn();
      let childPid = 0;
      let resolveFirst: () => void = () => {};
      const firstSeen = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      let resolveSecond: () => void = () => {};
      const secondSeen = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });

      const childProgram = [
        "process.stdout.write('one:' + process.pid + '\\n');",
        'setTimeout(() => process.stdout.write("two\\n"), 180);',
        'setTimeout(() => {}, 60_000);',
      ].join('');

      promise = spawnWithStdin({
        command: 'node',
        args: ['-e', childProgram],
        cwd: '.',
        onLine: (line) => {
          if (line.startsWith('one:')) {
            childPid = Number.parseInt(line.slice(4), 10);
            resolveFirst();
          }
          if (line === 'two') resolveSecond();
        },
        signal: controller.signal,
        idle: { warnMs: 75, killMs: 600_000, onWarn, onClear },
      });

      await firstSeen;
      onWarn.mockClear();
      onClear.mockClear();
      const firstWarned = new Promise<void>((resolve) => {
        resolveWarn = resolve;
      });
      await firstWarned;
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(onClear).not.toHaveBeenCalled();

      await secondSeen;
      expect(onClear).toHaveBeenCalledTimes(1);

      const secondWarned = new Promise<void>((resolve) => {
        resolveWarn = resolve;
      });
      await secondWarned;
      expect(onWarn).toHaveBeenCalledTimes(2);

      controller.abort();
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      controller.abort();
      await promise?.catch(() => {});
    }
  });

  it('output after the idle kill fires does not emit onClear or re-arm timers', async () => {
    const controller = new AbortController();
    let promise: ReturnType<typeof spawnWithStdin> | undefined;
    try {
      const onWarn = vi.fn();
      const onClear = vi.fn();
      let childPid = 0;
      let resolveReady: () => void = () => {};
      const readySeen = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });

      const childProgram = [
        "process.on('SIGTERM', () => {});",
        "process.stdout.write('ready:' + process.pid + '\\n');",
        'setTimeout(() => process.stdout.write("late\\n"), 650);',
        'setTimeout(() => process.exit(0), 900);',
        'setTimeout(() => {}, 60_000);',
      ].join('');

      promise = spawnWithStdin({
        command: 'node',
        args: ['-e', childProgram],
        cwd: '.',
        onLine: (line) => {
          if (line.startsWith('ready:')) {
            childPid = Number.parseInt(line.slice(6), 10);
            resolveReady();
          }
        },
        signal: controller.signal,
        idle: { warnMs: 100, killMs: 500, onWarn, onClear },
      });

      await readySeen;
      onWarn.mockClear();
      onClear.mockClear();
      await expect(promise).rejects.toMatchObject({ kind: 'command-idle-timeout' });

      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(onClear).not.toHaveBeenCalled();
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      controller.abort();
      await promise?.catch(() => {});
    }
  });
});
