import { describe, it, expect, afterEach, vi } from 'vitest';
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
  it('captures stdout from a simple command', { timeout: 60_000 }, async () => {
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

  it('skips an oversized unterminated stdout tail on a clean exit', {
    timeout: 60_000,
  }, async () => {
    const lines: string[] = [];
    const overflows: Array<{ lineBytes: number; maxLineBytes: number }> = [];
    const result = await spawnWithStdin({
      command: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(100))'],
      cwd: '.',
      notFoundMessage: 'node not found',
      onLine: (line) => lines.push(line),
      onStdoutLineOverflow: (overflow) => overflows.push(overflow),
      stdoutLineMaxBytes: 16,
    });

    expect(result.code).toBe(0);
    expect(lines).toEqual([]);
    expect(overflows).toEqual([expect.objectContaining({ lineBytes: 100, maxLineBytes: 16 })]);
  });

  it('writes stdin to process', { timeout: 60_000 }, async () => {
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

  it('captures stderr', { timeout: 60_000 }, async () => {
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

  it('rejects byte overflow with bounded partial stdout and stderr', {
    timeout: 60_000,
  }, async () => {
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

  it('caps retained text when byte overflow becomes fatal', { timeout: 60_000 }, async () => {
    const lines: string[] = [];
    let outcome: unknown;
    try {
      // 8 KiB fits a single pipe read, so the child is fully drained in the
      // chunk that trips the budget. A payload past the 64 KiB pipe buffer
      // would leave the tail's arrival racing the teardown.
      await spawnWithStdin({
        command: 'node',
        args: ['-e', 'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 60_000)'],
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
        bytesSeen: 8192,
        bytesStored: 1024,
        maxBytes: 1024,
        truncated: true,
      },
    });
  });

  it('bounds retention without tearing the child down when byte-limit aborts are off', {
    timeout: 60_000,
  }, async () => {
    const stderrChunks: string[] = [];
    const result = await spawnWithStdin({
      command: 'node',
      args: [
        '-e',
        [
          'process.stderr.write("stderr-head\\n");',
          'process.stderr.write("e".repeat(4096));',
          'process.stderr.write("\\nstderr-tail\\n");',
        ].join(''),
      ],
      cwd: '.',
      onLine: () => {},
      onStderr: (chunk) => stderrChunks.push(chunk),
      stderrMaxBytes: 128,
      abortOnByteLimit: false,
    });

    expect(result.code).toBe(0);
    expect(stderrChunks.join('')).toContain('stderr-head');
    expect(stderrChunks.join('')).toContain('stderr-tail');
    expect(result.stderrOutput).toContain('stderr-tail');
    expect(result.stderrMetadata).toMatchObject({ truncated: true, maxBytes: 128 });
    expect(result.stderrMetadata?.bytesStored ?? 0).toBeLessThanOrEqual(128);
  });

  it('rejects with notFoundMessage for missing command', { timeout: 60_000 }, async () => {
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

  it('rejects on non-zero exit with no stdout', { timeout: 60_000 }, async () => {
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

  it('rejects on non-zero exit even when stdout has content', { timeout: 60_000 }, async () => {
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

  it('rejects with AbortError when aborted after stdout', { timeout: 60_000 }, async () => {
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

  it('reaps descendants before rejecting when the final-line callback throws', {
    timeout: 60_000,
  }, async () => {
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

  it('kills the whole process group on abort so grandchildren are not orphaned', {
    timeout: 60_000,
  }, async () => {
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

const pendingRuns: Array<{ controller: AbortController; settled: Promise<void> }> = [];

// A run tracked here is aborted and awaited even when the test body itself
// times out, so a child never outlives the file and an idle-timeout rejection
// never surfaces as an unhandled rejection.
function track<T>(controller: AbortController, run: Promise<T>): Promise<T> {
  pendingRuns.push({
    controller,
    settled: run.then(
      () => {},
      () => {},
    ),
  });
  return run;
}

afterEach(async () => {
  const runs = pendingRuns.splice(0);
  for (const entry of runs) entry.controller.abort();
  await Promise.all(runs.map((entry) => entry.settled));
});

// The idle window arms at spawn, so any fixed `killMs` is really a fixed
// budget for interpreter startup — the one thing a saturated box inflates. A
// throwaway spawn measures what startup actually costs right now, and the
// window is sized from that instead of from a guess.
async function measureNodeStartupMs(): Promise<number> {
  const started = Date.now();
  await spawnWithStdin({
    command: 'node',
    args: ['-e', 'process.stdout.write("ready\\n")'],
    cwd: '.',
    onLine: () => {},
  });
  return Date.now() - started;
}

describe('idle watchdog', () => {
  it('idle kill terminates the process group and surfaces command-idle-timeout', {
    timeout: 60_000,
  }, async () => {
    const controller = new AbortController();
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

    // The child pays for two interpreter startups before it can speak, so the
    // window is four measured startups wide, never below the 5s floor.
    const startupMs = await measureNodeStartupMs();
    const killMs = Math.max(5000, startupMs * 4);

    const run = track(
      controller,
      spawnWithStdin({
        command: 'node',
        args: ['-e', childProgram],
        cwd: '.',
        onLine: (line) => {
          const pid = Number.parseInt(line.trim(), 10);
          if (Number.isInteger(pid)) resolveGrandchild(pid);
        },
        signal: controller.signal,
        idle: { warnMs: 250, killMs },
      }),
    );

    // Racing the PID against the run keeps the one unbounded wait out of the
    // test: a run that settles first means the kill beat the child's first
    // line, and that reports itself instead of blocking on a PID that can no
    // longer arrive.
    const settledFirst = Symbol('run settled before the grandchild PID');
    const pid = await Promise.race<number | symbol>([
      grandchildPid,
      run.then(
        () => settledFirst,
        () => settledFirst,
      ),
    ]);
    if (typeof pid !== 'number') {
      throw new Error(
        `the run settled before the child printed its grandchild PID (killMs=${killMs}, measured startup=${startupMs}ms)`,
      );
    }

    await expect(run).rejects.toMatchObject({ kind: 'command-idle-timeout' });

    expect(isProcessAlive(pid)).toBe(false);
  });

  it('output chunks reset the idle timers', { timeout: 60_000 }, async () => {
    const controller = new AbortController();
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

    // The tick answers a signal instead of a timer, so the second chunk is
    // causally after the first one was observed rather than racing it.
    const childProgram = [
      "process.on('SIGUSR1', () => process.stdout.write('tick\\n'));",
      "process.stdout.write('started:' + process.pid + '\\n');",
      'setTimeout(() => {}, 60_000);',
    ].join('');

    const run = track(
      controller,
      spawnWithTimeout({
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
        idle: { warnMs: 1000, killMs: 600_000, onWarn },
      }),
    );

    await started;
    onWarn.mockClear();
    const warned = new Promise<void>((resolve) => {
      resolveWarn = resolve;
    });
    process.kill(childPid, 'SIGUSR1');
    await tickSeen;
    expect(onWarn).not.toHaveBeenCalled();

    await warned;
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(warnAt - tickAt).toBeGreaterThanOrEqual(900);

    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(isProcessAlive(childPid)).toBe(false);
  });

  it('onWarn fires once per silence episode and onClear fires on the next output', {
    timeout: 60_000,
  }, async () => {
    const controller = new AbortController();
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

    // The second line answers a signal the test sends after the first warn, so
    // the two silence episodes cannot reorder under load.
    const childProgram = [
      "process.on('SIGUSR1', () => process.stdout.write('two\\n'));",
      "process.stdout.write('one:' + process.pid + '\\n');",
      'setTimeout(() => {}, 60_000);',
    ].join('');

    const run = track(
      controller,
      spawnWithStdin({
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
        idle: { warnMs: 300, killMs: 600_000, onWarn, onClear },
      }),
    );

    await firstSeen;
    onWarn.mockClear();
    onClear.mockClear();
    const firstWarned = new Promise<void>((resolve) => {
      resolveWarn = resolve;
    });
    await firstWarned;
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();

    const secondWarned = new Promise<void>((resolve) => {
      resolveWarn = resolve;
    });
    process.kill(childPid, 'SIGUSR1');
    await secondSeen;
    expect(onClear).toHaveBeenCalledTimes(1);

    await secondWarned;
    expect(onWarn).toHaveBeenCalledTimes(2);

    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(isProcessAlive(childPid)).toBe(false);
  });

  it('output after the idle kill fires does not emit onClear or re-arm timers', {
    timeout: 60_000,
  }, async () => {
    const controller = new AbortController();
    const onWarn = vi.fn();
    const onClear = vi.fn();
    let childPid = 0;
    let resolveReady: () => void = () => {};
    const readySeen = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    // The late write happens inside the SIGTERM handler, which only the idle
    // kill can trigger, so the output is strictly after the kill instead of
    // depending on the child's timer landing later than the watchdog's.
    const childProgram = [
      "process.on('SIGTERM', () => { process.stdout.write('late\\n'); setTimeout(() => process.exit(0), 50); });",
      "process.stdout.write('ready:' + process.pid + '\\n');",
      'setTimeout(() => {}, 60_000);',
    ].join('');

    const run = track(
      controller,
      spawnWithStdin({
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
        idle: { warnMs: 100, killMs: 5000, onWarn, onClear },
      }),
    );

    await readySeen;
    onWarn.mockClear();
    onClear.mockClear();
    await expect(run).rejects.toMatchObject({ kind: 'command-idle-timeout' });

    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
    expect(isProcessAlive(childPid)).toBe(false);
  });
});
