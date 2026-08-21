import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  abortProcess,
  clearProcessLedger,
  killAllProcesses,
  killProcess,
  registerProcess,
  setProcessLedger,
  unregisterProcess,
} from './registry.js';

describe('killAllProcesses', () => {
  const procs: ReturnType<typeof spawn>[] = [];

  afterEach(async () => {
    await killAllProcesses();
    for (const proc of procs) {
      unregisterProcess(proc);
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    procs.length = 0;
    setProcessLedger(null);
  });

  const waitForClose = (proc: ReturnType<typeof spawn>) =>
    new Promise<void>((resolve, reject) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => reject(new Error('process did not exit')), 3000);
      proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

  it('reaps every in-flight registered child in one sweep', async () => {
    const grouped = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const plain = spawn('sleep', ['60'], { stdio: 'ignore' });
    procs.push(grouped, plain);
    registerProcess(grouped, { group: true });
    registerProcess(plain);

    await killAllProcesses();
    await Promise.all([waitForClose(grouped), waitForClose(plain)]);

    expect(grouped.signalCode === 'SIGTERM' || grouped.exitCode !== null).toBe(true);
    expect(plain.signalCode === 'SIGTERM' || plain.exitCode !== null).toBe(true);
  });

  it('drains a process registered while cleanup is in flight', async () => {
    const firstPid = 2_147_482_996;
    const secondPid = 2_147_482_997;
    const first = { pid: firstPid, exitCode: null, signalCode: null } as ChildProcess;
    const second = { pid: secondPid, exitCode: null, signalCode: null } as ChildProcess;
    const alive = new Set([firstPid]);
    const signaled: number[] = [];
    registerProcess(first, { group: true, ledger: false });

    const processKill = vi.spyOn(process, 'kill').mockImplementation((targetPid, signal) => {
      const pid = -targetPid;
      if (signal === 0) {
        if (alive.has(pid)) return true;
        const absent: NodeJS.ErrnoException = new Error('absent');
        absent.code = 'ESRCH';
        throw absent;
      }
      if (signal === 'SIGTERM') {
        signaled.push(pid);
        if (pid === firstPid) {
          alive.add(secondPid);
          registerProcess(second, { group: true, ledger: false });
        }
        alive.delete(pid);
      }
      return true;
    });

    try {
      await killAllProcesses();
      expect(signaled).toEqual([firstPid, secondPid]);
    } finally {
      processKill.mockRestore();
    }
  });

  it('abort rejects a failed group escalation and retains ownership while unresolved', async () => {
    vi.useFakeTimers();
    const pid = 2_147_483_000;
    const proc = Object.assign(new EventEmitter(), {
      pid,
      exitCode: null,
      signalCode: null,
    }) as ChildProcess;
    const recorded: number[] = [];
    const released: number[] = [];
    let groupAlive = true;
    setProcessLedger({
      record: (recordedPid) => recorded.push(recordedPid),
      release: (releasedPid) => released.push(releasedPid),
    });
    registerProcess(proc, { group: true });

    const signalCause: NodeJS.ErrnoException = new Error('unavailable');
    signalCause.code = 'EPERM';

    const processKill = vi.spyOn(process, 'kill').mockImplementation((targetPid, signal) => {
      if (targetPid !== -pid) return true;
      if (signal === 0) {
        if (groupAlive) return true;
        const absent: NodeJS.ErrnoException = new Error('absent');
        absent.code = 'ESRCH';
        throw absent;
      }
      if (signal === 'SIGKILL') {
        throw signalCause;
      }
      return true;
    });

    try {
      const controller = new AbortController();
      const termination = abortProcess(proc, controller.signal, { group: true });
      const failure = termination.catch((err: unknown) => err);
      controller.abort();
      await vi.advanceTimersByTimeAsync(3000);
      const err = await failure;
      expect(err).toMatchObject({
        kind: 'platform-limitation',
        data: { operation: 'signal', target: 'process-group', signal: 'SIGKILL' },
      });
      expect(err).toHaveProperty('message', 'Unable to send SIGKILL to process-group');
      expect(err).toHaveProperty('data', {
        operation: 'signal',
        target: 'process-group',
        signal: 'SIGKILL',
      });
      expect(err).toHaveProperty('cause', signalCause);

      expect(recorded).toEqual([pid]);
      expect(released).toEqual([]);

      groupAlive = false;
      await killProcess(proc, { group: true });
      expect(released).toEqual([pid]);
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('preserves an absence-check failure as the platform limitation cause', async () => {
    const pid = 2_147_482_998;
    const proc = { pid, exitCode: null, signalCode: null } as ChildProcess;
    const absenceCause: NodeJS.ErrnoException = new Error('invalid process target');
    absenceCause.code = 'EINVAL';
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw absenceCause;
    });

    try {
      await expect(killProcess(proc, { group: true })).rejects.toMatchObject({
        kind: 'platform-limitation',
        data: { operation: 'verify-absence', target: 'process-group', signal: null },
        cause: absenceCause,
      });
    } finally {
      processKill.mockRestore();
    }
  });

  it('accepts a false signal result when the process disappeared after the pre-check', async () => {
    const proc = {
      pid: 2_147_482_995,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(function (this: { exitCode: number | null }) {
        this.exitCode = 0;
        return false;
      }),
    } as unknown as ChildProcess;

    await expect(killProcess(proc)).resolves.toBeUndefined();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects an ESRCH signal result when the process group remains live', async () => {
    vi.useFakeTimers();
    const pid = 2_147_482_994;
    const proc = { pid, exitCode: null, signalCode: null } as ChildProcess;
    const signalCause: NodeJS.ErrnoException = new Error('signal target disappeared');
    signalCause.code = 'ESRCH';
    const processKill = vi.spyOn(process, 'kill').mockImplementation((targetPid, signal) => {
      if (targetPid === -pid && signal === 'SIGTERM') throw signalCause;
      return true;
    });

    try {
      const termination = killProcess(proc, { group: true });
      const failure = termination.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await failure).toMatchObject({
        kind: 'platform-limitation',
        data: { operation: 'signal', target: 'process-group', signal: 'SIGTERM' },
        cause: signalCause,
      });
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['ESRCH', 'EPERM'] as const)(
    'accepts %s when the process group disappears during signal reconciliation',
    async (signalCode) => {
      vi.useFakeTimers();
      const pid = 2_147_482_992;
      const proc = { pid, exitCode: null, signalCode: null } as ChildProcess;
      let groupAlive = true;
      const signalCause: NodeJS.ErrnoException = new Error('signal target disappeared');
      signalCause.code = signalCode;
      const processKill = vi.spyOn(process, 'kill').mockImplementation((targetPid, signal) => {
        if (targetPid !== -pid) return true;
        if (signal === 0) {
          if (groupAlive) return true;
          const absent: NodeJS.ErrnoException = new Error('absent');
          absent.code = 'ESRCH';
          throw absent;
        }
        throw signalCause;
      });

      try {
        const termination = killProcess(proc, { group: true });
        setTimeout(() => {
          groupAlive = false;
        }, 20);
        await vi.advanceTimersByTimeAsync(30);
        await expect(termination).resolves.toBeUndefined();
      } finally {
        processKill.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it('types an inspection failure after ESRCH as absence verification', async () => {
    const pid = 2_147_482_993;
    const proc = { pid, exitCode: null, signalCode: null } as ChildProcess;
    const signalCause: NodeJS.ErrnoException = new Error('signal target disappeared');
    signalCause.code = 'ESRCH';
    const inspectionCause: NodeJS.ErrnoException = new Error('inspection unavailable');
    inspectionCause.code = 'EINVAL';
    let checkedOnce = false;
    const processKill = vi.spyOn(process, 'kill').mockImplementation((targetPid, signal) => {
      if (targetPid !== -pid) return true;
      if (signal === 0) {
        if (!checkedOnce) {
          checkedOnce = true;
          return true;
        }
        throw inspectionCause;
      }
      throw signalCause;
    });

    try {
      await expect(killProcess(proc, { group: true })).rejects.toMatchObject({
        kind: 'platform-limitation',
        data: { operation: 'verify-absence', target: 'process-group', signal: 'SIGTERM' },
        cause: inspectionCause,
      });
    } finally {
      processKill.mockRestore();
    }
  });

  it('rejects when a group remains live after SIGKILL and retains ownership', async () => {
    vi.useFakeTimers();
    const pid = 2_147_482_999;
    const proc = { pid, exitCode: null, signalCode: null } as ChildProcess;
    const released: number[] = [];
    let groupAlive = true;
    setProcessLedger({
      record: () => {},
      release: (releasedPid) => released.push(releasedPid),
    });
    registerProcess(proc, { group: true });

    const processKill = vi.spyOn(process, 'kill').mockImplementation((targetPid, signal) => {
      if (targetPid !== -pid) return true;
      if (signal === 0 && !groupAlive) {
        const absent: NodeJS.ErrnoException = new Error('absent');
        absent.code = 'ESRCH';
        throw absent;
      }
      return true;
    });

    try {
      const termination = killProcess(proc, { group: true });
      const failure = termination.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(3000);
      const err = await failure;
      expect(err).toMatchObject({
        kind: 'platform-limitation',
        data: { operation: 'verify-absence', target: 'process-group', signal: 'SIGKILL' },
      });
      expect(err).toHaveProperty(
        'message',
        'process-group absence could not be verified after SIGKILL',
      );
      expect(err).toHaveProperty('data', {
        operation: 'verify-absence',
        target: 'process-group',
        signal: 'SIGKILL',
      });

      expect(released).toEqual([]);

      groupAlive = false;
      await killProcess(proc, { group: true });
      expect(released).toEqual([pid]);
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('shutdown escalation reaps a descendant when its leader exits and retains the ledger until the group is absent', async () => {
    const recorded: number[] = [];
    const released: number[] = [];
    setProcessLedger({
      record: (pid) => recorded.push(pid),
      release: (pid) => released.push(pid),
    });

    const leader = spawn(
      process.execPath,
      [
        '-e',
        [
          'const { spawn } = require("node:child_process");',
          'const descendant = spawn(process.execPath, ["-e", `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready")`], { stdio: ["ignore", "pipe", "ignore"] });',
          'descendant.stdout.once("data", () => process.stdout.write(String(descendant.pid)));',
          'process.on("SIGTERM", () => process.exit(0));',
          'setInterval(() => {}, 1000);',
        ].join(' '),
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    procs.push(leader);
    const descendantPid = await new Promise<number>((resolve) => {
      leader.stdout?.once('data', (chunk: Buffer) =>
        resolve(Number.parseInt(chunk.toString(), 10)),
      );
    });
    registerProcess(leader, { group: true });
    expect(recorded).toEqual([leader.pid]);

    const leaderClosed = waitForClose(leader);
    const startedAt = Date.now();
    const firstCleanup = killAllProcesses();
    const concurrentCleanup = killAllProcesses();
    expect(concurrentCleanup).toBe(firstCleanup);
    await leaderClosed;
    expect(released).toEqual([]);

    await firstCleanup;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1950);
    expect(released).toEqual([leader.pid]);
    expect(() => process.kill(descendantPid, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );
  });

  it('abort shutdown is awaitable through escalation', async () => {
    const proc = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { detached: true, stdio: 'ignore' },
    );
    procs.push(proc);
    registerProcess(proc, { group: true, ledger: false });
    await new Promise<void>((resolve) => proc.once('spawn', resolve));

    const controller = new AbortController();
    const aborted = abortProcess(proc, controller.signal, { group: true });
    controller.abort();
    await aborted;

    expect(() => process.kill(proc.pid ?? 0, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );
  });
});

describe('setProcessLedger', () => {
  const procs: ReturnType<typeof spawn>[] = [];

  afterEach(async () => {
    await killAllProcesses();
    for (const proc of procs) {
      unregisterProcess(proc);
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
    procs.length = 0;
    setProcessLedger(null);
  });

  it('registerProcess records group-spawned pids and retains them until the group is absent', async () => {
    const recorded: Array<{ pid: number; startTimeMs: number | null }> = [];
    const released: number[] = [];
    setProcessLedger({
      record: (pid, startTimeMs) => recorded.push({ pid, startTimeMs }),
      release: (pid) => released.push(pid),
    });

    const proc = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    procs.push(proc);

    registerProcess(proc, { group: true });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.pid).toBe(proc.pid);
    expect(recorded[0]?.startTimeMs === null || typeof recorded[0]?.startTimeMs === 'number').toBe(
      true,
    );

    unregisterProcess(proc);
    expect(released).toEqual([]);
    await killProcess(proc, { group: true });
    expect(released).toEqual([proc.pid]);
  });

  it('ledger: false registers the process without recording or releasing ledger entries', () => {
    const recorded: number[] = [];
    const released: number[] = [];
    setProcessLedger({
      record: (pid) => recorded.push(pid),
      release: (pid) => released.push(pid),
    });

    const proc = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    procs.push(proc);

    registerProcess(proc, { group: true, ledger: false });
    unregisterProcess(proc);

    expect(recorded).toEqual([]);
    expect(released).toEqual([]);
  });

  it('clearProcessLedger only uninstalls the ledger it is given', () => {
    const recorded: number[] = [];
    const current = {
      record: (pid: number) => {
        recorded.push(pid);
      },
      release: () => {},
    };
    const superseded = { record: () => {}, release: () => {} };
    setProcessLedger(current);

    // A superseded run's late teardown must not null the successor's ledger.
    clearProcessLedger(superseded);
    const proc = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    procs.push(proc);
    registerProcess(proc, { group: true });
    expect(recorded).toEqual([proc.pid]);

    // The owner's own clear removes it.
    clearProcessLedger(current);
    const second = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    procs.push(second);
    registerProcess(second, { group: true });
    expect(recorded).toEqual([proc.pid]);
  });

  it('a throwing ledger warns instead of propagating out of register/unregister', () => {
    setProcessLedger({
      record: () => {
        throw new Error('ledger disk full');
      },
      release: () => {
        throw new Error('ledger disk full');
      },
    });

    const proc = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    procs.push(proc);

    const warnings: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      warnings.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      expect(() => registerProcess(proc, { group: true })).not.toThrow();
      expect(() => unregisterProcess(proc)).not.toThrow();
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    expect(warnings.join('')).toContain('ledger disk full');
  });
});

describe('Windows process-tree fail-closed boundary', () => {
  it('rejects leader-only cleanup instead of claiming descendants were reaped', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const proc = {
      pid: 42_424,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;
    const processKill = vi.spyOn(process, 'kill');

    try {
      await expect(killProcess(proc, { group: false })).rejects.toMatchObject({
        kind: 'platform-limitation',
        data: { operation: 'verify-absence', target: 'process-group', signal: null },
      });
      expect(proc.kill).not.toHaveBeenCalled();
      expect(processKill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('reports the same typed limitation when an abort requests cleanup', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const proc = {
      pid: 42_425,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as ChildProcess;
    const controller = new AbortController();

    try {
      const termination = abortProcess(proc, controller.signal, { group: false });
      controller.abort();
      await expect(termination).rejects.toMatchObject({
        kind: 'platform-limitation',
        data: { operation: 'verify-absence', target: 'process-group', signal: null },
      });
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});

describe('killProcess', () => {
  it('kills a long-running process', async () => {
    const proc = spawn('node', ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => {
      proc.on('spawn', resolve);
    });
    expect(proc.exitCode).toBe(null);
    await killProcess(proc);
    expect(proc.killed).toBeTruthy();
  });
});
