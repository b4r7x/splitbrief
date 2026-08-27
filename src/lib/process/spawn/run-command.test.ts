import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { runCommand } from './run-command.js';
import { spawnPipe, type SpawnPipeFatalOutcome } from './lifecycle.js';
import { killProcess, setProcessLedger } from '../registry.js';
import { processError } from '../errors.js';

function isFatalOutcome(value: unknown): value is SpawnPipeFatalOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    'state' in value &&
    (value.state === 'output-budget-breach' ||
      value.state === 'protocol-failure' ||
      value.state === 'callback-failure') &&
    'stdoutMetadata' in value &&
    'stderrMetadata' in value
  );
}

async function rejectedFatalOutcome(promise: Promise<unknown>): Promise<SpawnPipeFatalOutcome> {
  try {
    await promise;
  } catch (err: unknown) {
    if (isFatalOutcome(err)) return err;
    throw err;
  }
  throw new Error('expected a fatal process outcome');
}

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} remained live`);
}

function stubbornProcessGroupProgram(): string {
  const descendantProgram = [
    'process.on("SIGTERM", () => {});',
    'process.stdout.write("ready");',
    'setInterval(() => {}, 1000);',
  ].join('');
  return [
    'const { spawn } = require("node:child_process");',
    'process.on("SIGTERM", () => {});',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantProgram)}], { stdio: ["ignore", "pipe", "ignore"] });`,
    'child.stdout.once("data", () => {',
    '  process.stdout.write(String(process.pid) + " " + String(child.pid) + "\\n");',
    '});',
    'setInterval(() => {}, 1000);',
  ].join('');
}

describe('spawnPipe child environment', () => {
  it('applies an explicit child environment and never an ambient one', {
    timeout: 60_000,
  }, async () => {
    const original = process.env.SPLITBRIEF_SCOPED_ENV_TEST;
    delete process.env.SPLITBRIEF_SCOPED_ENV_TEST;
    const readChildValue = async (env?: NodeJS.ProcessEnv): Promise<string> => {
      let output = '';
      await spawnPipe({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.SPLITBRIEF_SCOPED_ENV_TEST ?? "missing")'],
        ...(env !== undefined && { env }),
        onStdout: (chunk) => {
          output += chunk;
        },
        onStderr: () => {},
        onClose: () => undefined,
      });
      return output;
    };
    try {
      expect(await readChildValue({ SPLITBRIEF_SCOPED_ENV_TEST: 'explicit' })).toBe('explicit');
      // A spawn that declares no environment inherits this process, never an
      // environment a surrounding async scope happens to have installed.
      expect(await readChildValue()).toBe('missing');
      expect(process.env.SPLITBRIEF_SCOPED_ENV_TEST).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.SPLITBRIEF_SCOPED_ENV_TEST = original;
    }
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runCommand', () => {
  it('fails closed on Windows before launching a process without a tree-reaping path', {
    timeout: 60_000,
  }, async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    let spawned = false;
    try {
      await expect(
        spawnPipe({
          command: process.execPath,
          args: ['-e', 'process.stdout.write("must-not-run")'],
          onSpawned: () => {
            spawned = true;
          },
          onStdout: () => {},
          onStderr: () => {},
          onClose: () => undefined,
        }),
      ).rejects.toMatchObject({
        kind: 'platform-limitation',
        data: { operation: 'verify-absence', target: 'process-group', signal: null },
      });
      expect(spawned).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('resolves with stdout, stderr, and exit code', { timeout: 60_000 }, async () => {
    const result = await runCommand('echo', ['hello']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.code).toBe(0);
  });

  it('rejects with error for nonexistent command (ENOENT) without leaking timer', {
    timeout: 60_000,
  }, async () => {
    const start = Date.now();
    await expect(
      runCommand('nonexistent-command-that-does-not-exist-xyz', [], { timeout: 60_000 }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('captures stderr output', { timeout: 60_000 }, async () => {
    const result = await runCommand('node', ['-e', 'console.error("oops")']);
    expect(result.stderr).toContain('oops');
    expect(result.code).toBe(0);
  });

  it('retains bounded stdout and stderr snapshots for large command output', {
    timeout: 60_000,
  }, async () => {
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

  it('rejects with a process-output error on nonzero exit', { timeout: 60_000 }, async () => {
    await expect(runCommand('node', ['-e', 'process.exit(42)'])).rejects.toMatchObject({
      kind: 'process-output',
    });
  });

  it('rejects with a timeout-kinded error when the command exceeds the timeout', {
    timeout: 60_000,
  }, async () => {
    await expect(
      runCommand('node', ['-e', 'setTimeout(() => {}, 10_000)'], { timeout: 100 }),
    ).rejects.toMatchObject({ kind: 'command-timeout' });
  });

  it('returns from timeout only after a stubborn descendant group is absent', {
    timeout: 60_000,
  }, async () => {
    let leaderPid = 0;
    let descendantPid = 0;
    try {
      await runCommand(process.execPath, ['-e', stubbornProcessGroupProgram()], { timeout: 1_000 });
      throw new Error('expected command to time out');
    } catch (err: unknown) {
      expect(processError.isTimeout(err)).toBe(true);
      if (!processError.isTimeout(err)) throw err;
      const data = err.data as { output?: string };
      const pids = data.output?.trim().split(/\s+/).map(Number) ?? [];
      leaderPid = pids[0] ?? 0;
      descendantPid = pids[1] ?? 0;
    }

    expect(leaderPid).toBeGreaterThan(1);
    expect(descendantPid).toBeGreaterThan(1);
    expect(processExists(-leaderPid)).toBe(false);
    expect(processExists(descendantPid)).toBe(false);
  });

  it('uses the provided label in the timeout message', { timeout: 60_000 }, async () => {
    await expect(
      runCommand('node', ['-e', 'setTimeout(() => {}, 10_000)'], {
        timeout: 100,
        label: 'typecheck validation',
      }),
    ).rejects.toThrow('typecheck validation timed out');
  });

  it('caps retained stdout and reports truncation metadata', { timeout: 60_000 }, async () => {
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

  it('uses bounded stderr and stdout in process-output errors', { timeout: 60_000 }, async () => {
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

  it('runCommand spawns bypass the runner-pid ledger', { timeout: 60_000 }, async () => {
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

  it('fatal byte budget aborts and reaps the producer group with bounded partial output', {
    timeout: 60_000,
  }, async () => {
    let leaderPid = 0;
    let descendantPid = 0;
    const childProgram = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'process.stdout.write(String(child.pid) + "\\n");',
      'setTimeout(() => setInterval(() => process.stdout.write("x".repeat(128)), 1), 50);',
    ].join('');

    const outcome = await rejectedFatalOutcome(
      spawnPipe({
        command: process.execPath,
        args: ['-e', childProgram],
        detached: true,
        ledger: false,
        outputBudgetBytes: 256,
        partialStdoutMaxBytes: 64,
        partialStderrMaxBytes: 32,
        onSpawned: (proc) => {
          leaderPid = proc.pid ?? 0;
        },
        onStdout: (chunk) => {
          if (descendantPid === 0) descendantPid = Number.parseInt(chunk, 10);
        },
        onStderr: () => {},
        onClose: () => undefined,
      }),
    );

    expect(outcome).toMatchObject({
      state: 'output-budget-breach',
      stderr: '',
      stdoutMetadata: { truncated: true, maxBytes: 64 },
    });
    expect(Buffer.byteLength(outcome.stdout, 'utf8')).toBeLessThanOrEqual(64);
    expect(outcome.stdout).toContain('output truncated');
    expect(leaderPid).toBeGreaterThan(1);
    expect(descendantPid).toBeGreaterThan(1);
    await Promise.all([waitForPidExit(leaderPid), waitForPidExit(descendantPid)]);
  });

  it.each(['abort', 'fatal callback'] as const)(
    'propagates a process-group cleanup limitation from %s termination',
    {
      timeout: 60_000,
    },
    async (trigger) => {
      const controller = new AbortController();
      const recorded: number[] = [];
      const released: number[] = [];
      let proc: ChildProcess | undefined;
      let resolveSpawned = () => {};
      const spawned = new Promise<void>((resolve) => {
        resolveSpawned = resolve;
      });
      const signalCause: NodeJS.ErrnoException = new Error('signal unavailable');
      signalCause.code = 'EPERM';
      const realKill = process.kill.bind(process);
      setProcessLedger({
        record: (pid) => recorded.push(pid),
        release: (pid) => released.push(pid),
      });
      const processKill = vi.spyOn(process, 'kill').mockImplementation((targetPid, signal) => {
        if (proc?.pid !== undefined && targetPid === -proc.pid && signal === 'SIGTERM') {
          throw signalCause;
        }
        return realKill(targetPid, signal);
      });

      try {
        const result = spawnPipe({
          command: process.execPath,
          args: ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);'],
          detached: true,
          signal: controller.signal,
          onSpawned: (spawnedProc) => {
            proc = spawnedProc;
            resolveSpawned();
          },
          onStdout: () =>
            trigger === 'fatal callback'
              ? { state: 'protocol-failure', remediation: 'invalid output' }
              : undefined,
          onStderr: () => {},
          onClose: () => undefined,
        });
        await spawned;
        if (trigger === 'abort') controller.abort();

        await expect(result).rejects.toMatchObject({
          kind: 'platform-limitation',
          data: { operation: 'signal', target: 'process-group', signal: 'SIGTERM' },
          cause: signalCause,
        });
        expect(recorded).toEqual([proc?.pid]);
        expect(released).toEqual([]);
      } finally {
        processKill.mockRestore();
        controller.abort();
        if (proc !== undefined) await killProcess(proc, { group: true });
        setProcessLedger(null);
      }

      expect(released).toEqual([proc?.pid]);
    },
  );

  it('fatal line, event, diagnostic, and parser signals retain distinct outcomes', {
    timeout: 60_000,
  }, async () => {
    const cases: Array<{
      label: string;
      channel: 'stdout' | 'stderr';
      state: 'output-budget-breach' | 'protocol-failure';
    }> = [
      { label: 'line budget', channel: 'stdout', state: 'output-budget-breach' },
      { label: 'diagnostic budget', channel: 'stderr', state: 'output-budget-breach' },
      { label: 'parser terminal', channel: 'stdout', state: 'protocol-failure' },
    ];

    for (const testCase of cases) {
      const outcome = await rejectedFatalOutcome(
        spawnPipe({
          command: process.execPath,
          args: [
            '-e',
            'process.stdout.write("stdout-ready"); process.stderr.write("stderr-ready"); setInterval(() => {}, 1000);',
          ],
          detached: true,
          ledger: false,
          partialStdoutMaxBytes: 32,
          partialStderrMaxBytes: 32,
          onStdout: () =>
            testCase.channel === 'stdout'
              ? { state: testCase.state, remediation: testCase.label }
              : undefined,
          onStderr: () =>
            testCase.channel === 'stderr'
              ? { state: testCase.state, remediation: testCase.label }
              : undefined,
          onClose: () => undefined,
        }),
      );

      expect(outcome).toMatchObject({ state: testCase.state, remediation: testCase.label });
      expect(Buffer.byteLength(outcome.stdout, 'utf8')).toBeLessThanOrEqual(32);
      expect(Buffer.byteLength(outcome.stderr, 'utf8')).toBeLessThanOrEqual(32);
    }
  });

  it('callback fatality uses the once-only callback outcome and preserves prior diagnostics', {
    timeout: 60_000,
  }, async () => {
    let producerPid = 0;
    const outcome = await rejectedFatalOutcome(
      spawnPipe({
        command: process.execPath,
        args: [
          '-e',
          'process.stderr.write("diagnostic-before-callback"); setTimeout(() => process.stdout.write("callback-trigger"), 25); setInterval(() => {}, 1000);',
        ],
        detached: true,
        ledger: false,
        partialStdoutMaxBytes: 48,
        partialStderrMaxBytes: 48,
        onSpawned: (proc) => {
          producerPid = proc.pid ?? 0;
        },
        onStdout: () => {
          throw new Error('callback must not escape the process boundary');
        },
        onStderr: () => {},
        onClose: () => undefined,
      }),
    );

    expect(outcome).toMatchObject({
      state: 'callback-failure',
      remediation: 'Resolve the callback error, then retry.',
    });
    expect(outcome.stdout).toContain('callback-trigger');
    expect(outcome.stderr).toContain('diagnostic-before-callback');
    await waitForPidExit(producerPid);
  });
});
