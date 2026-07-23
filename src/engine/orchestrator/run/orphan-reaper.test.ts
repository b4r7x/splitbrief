import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir, LOCKFILE } from '../../../core/paths.js';
import {
  currentProcessStartTimeMs,
  readProcessStartTimeMs,
} from '../../../lib/process/start-time.js';
import { recordRunnerPid, readRunnerPids } from '../../../core/sessions/runner-pids.js';
import { reapOrphanRunners } from './orphan-reaper.js';

const mockedStartTimes = new Map<number, number | null>();

function reaperDeps() {
  return {
    readProcessStartTimeMs: (pid: number): number | null =>
      mockedStartTimes.has(pid) ? (mockedStartTimes.get(pid) ?? null) : readProcessStartTimeMs(pid),
  };
}

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  mockedStartTimes.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function writeLockfile(
  projectDir: string,
  sessionId: string,
  overrides: Record<string, unknown> = {},
): void {
  const sDir = sessionDir(projectDir, sessionId);
  mkdirSync(sDir, { recursive: true });
  writeFileSync(
    join(sDir, LOCKFILE),
    JSON.stringify({
      version: 1,
      pid: 40001,
      startTimeMs: 1000,
      lastAliveMs: Date.now(),
      sessionId,
      mode: 'standard',
      feature: 'feature',
      ...overrides,
    }),
  );
}

type KillCall = { pid: number; signal: string | number | undefined };

function installKillSpy(alivePids: Set<number>): KillCall[] {
  const calls: KillCall[] = [];
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number): true => {
    calls.push({ pid, signal });
    if (!alivePids.has(Math.abs(pid))) {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    }
    return true;
  });
  return calls;
}

describe('reapOrphanRunners', () => {
  it('kills ledger pids of dead sessions and clears the ledger', async () => {
    vi.useFakeTimers();
    tmp = createTempDir('orphan-reaper-test');
    // The session's own lockfile pid (40001) is absent from alivePids, so its
    // control process reads as dead. Ledger pid 50001 stays alive throughout so
    // both the SIGTERM and the post-grace SIGKILL escalation are observable.
    const calls = installKillSpy(new Set([50001]));

    writeLockfile(tmp, 'dead-session', { pid: 40001, startTimeMs: 1000 });
    recordRunnerPid({ projectDir: tmp, sessionId: 'dead-session' }, 50001, 111_000);
    mockedStartTimes.set(50001, 111_000);

    const reaping = reapOrphanRunners(tmp, reaperDeps());
    await vi.advanceTimersByTimeAsync(2000);
    await reaping;

    expect(calls).toContainEqual({ pid: -50001, signal: 'SIGTERM' });
    expect(calls).toContainEqual({ pid: -50001, signal: 'SIGKILL' });
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'dead-session' })).toEqual([]);
  });

  it('a pid recorded by a concurrently resumed session during the SIGKILL grace survives the release', async () => {
    vi.useFakeTimers();
    tmp = createTempDir('orphan-reaper-test');
    const calls = installKillSpy(new Set([50081]));

    writeLockfile(tmp, 'dead-session', { pid: 40081, startTimeMs: 1000 });
    recordRunnerPid({ projectDir: tmp, sessionId: 'dead-session' }, 50081, 111_000);
    mockedStartTimes.set(50081, 111_000);

    const reaping = reapOrphanRunners(tmp, reaperDeps());
    // A session resumed concurrently records a fresh runner pid while this reap
    // is mid-grace (SIGTERM already sent, awaiting the SIGKILL window) — it must
    // survive the ledger release below, not be wiped along with the reaped pid.
    recordRunnerPid({ projectDir: tmp, sessionId: 'dead-session' }, 60081, 222_000);
    await vi.advanceTimersByTimeAsync(2000);
    await reaping;

    expect(calls).toContainEqual({ pid: -50081, signal: 'SIGTERM' });
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'dead-session' })).toEqual([
      { pid: 60081, startTimeMs: 222_000 },
    ]);
  });

  it('live sessions and reused pids are left untouched', async () => {
    tmp = createTempDir('orphan-reaper-test');
    const currentStart = currentProcessStartTimeMs();
    const calls = installKillSpy(new Set([process.pid]));

    // Live session: its lockfile pid is the current (alive) test process.
    writeLockfile(tmp, 'live-session', {
      pid: process.pid,
      startTimeMs: currentStart,
      lastAliveMs: Date.now(),
    });
    recordRunnerPid({ projectDir: tmp, sessionId: 'live-session' }, 60001, 3000);

    // Dead session whose ledger pid was recycled: the recorded start time no
    // longer matches the live process now holding that pid, so it must not be killed.
    writeLockfile(tmp, 'dead-session-recycled', { pid: 40002, startTimeMs: 1000 });
    recordRunnerPid(
      { projectDir: tmp, sessionId: 'dead-session-recycled' },
      process.pid,
      currentStart - 1_000_000,
    );

    await reapOrphanRunners(tmp, reaperDeps());

    // Signal 0 liveness probes (from the session status check) are expected;
    // only destructive signals to the protected pids are disallowed.
    const destructiveCalls = calls.filter(
      (call) => call.signal === 'SIGTERM' || call.signal === 'SIGKILL',
    );
    expect(destructiveCalls.some((call) => Math.abs(call.pid) === 60001)).toBe(false);
    expect(destructiveCalls.some((call) => Math.abs(call.pid) === process.pid)).toBe(false);
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'live-session' })).toEqual([
      { pid: 60001, startTimeMs: 3000 },
    ]);
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'dead-session-recycled' })).toEqual([]);
  });

  it('a stale session whose process is alive is left untouched', async () => {
    tmp = createTempDir('orphan-reaper-test');
    const calls = installKillSpy(new Set([process.pid]));

    // Heartbeat stopped >8s ago (suspended TUI, wedged event loop) but the
    // owning process is alive — its in-flight runners must not be killed.
    writeLockfile(tmp, 'stale-session', {
      pid: process.pid,
      startTimeMs: currentProcessStartTimeMs(),
      lastAliveMs: Date.now() - 60_000,
    });
    recordRunnerPid({ projectDir: tmp, sessionId: 'stale-session' }, 60011, 3000);

    await reapOrphanRunners(tmp, reaperDeps());

    const destructiveCalls = calls.filter(
      (call) => call.signal === 'SIGTERM' || call.signal === 'SIGKILL',
    );
    expect(destructiveCalls).toEqual([]);
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'stale-session' })).toEqual([
      { pid: 60011, startTimeMs: 3000 },
    ]);
  });

  it('reaps ledger pids of a session that recorded a clean exit', async () => {
    vi.useFakeTimers();
    tmp = createTempDir('orphan-reaper-test');
    const calls = installKillSpy(new Set([50051]));

    // Clean release wrote exitedAt, but a SIGTERM-ignoring child outlived the
    // exit (the unref'd SIGKILL escalation died with the process).
    writeLockfile(tmp, 'exited-session', {
      pid: 40051,
      startTimeMs: 1000,
      exitedAt: Date.now(),
      exitCode: 0,
    });
    recordRunnerPid({ projectDir: tmp, sessionId: 'exited-session' }, 50051, 111_000);
    mockedStartTimes.set(50051, 111_000);

    const reaping = reapOrphanRunners(tmp, reaperDeps());
    await vi.advanceTimersByTimeAsync(2000);
    await reaping;

    expect(calls).toContainEqual({ pid: -50051, signal: 'SIGTERM' });
    expect(calls).toContainEqual({ pid: -50051, signal: 'SIGKILL' });
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'exited-session' })).toEqual([]);
  });

  it('reaps multiple dead sessions in parallel within one grace window', async () => {
    vi.useFakeTimers();
    tmp = createTempDir('orphan-reaper-test');
    const calls = installKillSpy(new Set([50011, 50012]));

    writeLockfile(tmp, 'dead-a', { pid: 40011, startTimeMs: 1000 });
    recordRunnerPid({ projectDir: tmp, sessionId: 'dead-a' }, 50011, 111_000);
    mockedStartTimes.set(50011, 111_000);

    writeLockfile(tmp, 'dead-b', { pid: 40012, startTimeMs: 1000 });
    recordRunnerPid({ projectDir: tmp, sessionId: 'dead-b' }, 50012, 222_000);
    mockedStartTimes.set(50012, 222_000);

    const reaping = reapOrphanRunners(tmp, reaperDeps());
    // A single grace window covers both sessions — sequential reaping would
    // need 2 × SIGKILL_GRACE_MS before settling.
    await vi.advanceTimersByTimeAsync(2000);
    await reaping;

    for (const pid of [50011, 50012]) {
      expect(calls).toContainEqual({ pid: -pid, signal: 'SIGTERM' });
      expect(calls).toContainEqual({ pid: -pid, signal: 'SIGKILL' });
    }
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'dead-a' })).toEqual([]);
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'dead-b' })).toEqual([]);
  });

  it('never signals ledger entries with pid 1 or a null start time', async () => {
    tmp = createTempDir('orphan-reaper-test');
    const calls = installKillSpy(new Set([1, 50021]));

    writeLockfile(tmp, 'dead-session', { pid: 40021, startTimeMs: 1000 });
    recordRunnerPid({ projectDir: tmp, sessionId: 'dead-session' }, 1, 111_000);
    recordRunnerPid({ projectDir: tmp, sessionId: 'dead-session' }, 50021, null);
    // Even with a matching start time, pid 1 must never be group-signaled:
    // process.kill(-1, …) broadcasts to every process the user can signal.
    mockedStartTimes.set(1, 111_000);

    await reapOrphanRunners(tmp, reaperDeps());

    const destructiveCalls = calls.filter(
      (call) => call.signal === 'SIGTERM' || call.signal === 'SIGKILL',
    );
    expect(destructiveCalls).toEqual([]);
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'dead-session' })).toEqual([]);
  });

  it('a session with an unreadable pid ledger is skipped without blocking other sessions', async () => {
    vi.useFakeTimers();
    tmp = createTempDir('orphan-reaper-test');
    const calls = installKillSpy(new Set([50031]));

    // runner-pids.jsonl as a directory makes readRunnerPids throw (EISDIR).
    writeLockfile(tmp, 'broken-session', { pid: 40031, startTimeMs: 1000 });
    mkdirSync(join(sessionDir(tmp, 'broken-session'), 'runner-pids.jsonl'), { recursive: true });

    writeLockfile(tmp, 'dead-session', { pid: 40032, startTimeMs: 1000 });
    recordRunnerPid({ projectDir: tmp, sessionId: 'dead-session' }, 50031, 111_000);
    mockedStartTimes.set(50031, 111_000);

    const reaping = reapOrphanRunners(tmp, reaperDeps());
    await vi.advanceTimersByTimeAsync(2000);
    await expect(reaping).resolves.toBeUndefined();

    expect(calls).toContainEqual({ pid: -50031, signal: 'SIGTERM' });
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'dead-session' })).toEqual([]);
  });

  it('a live pid whose start time cannot be read is never signalled', async () => {
    tmp = createTempDir('orphan-reaper-test');
    // The ledger pid stays alive throughout, but its start time is unreadable
    // (mocked to null) — with zero identity proof it must be treated as
    // recycled and spared, never signalled.
    const calls = installKillSpy(new Set([50061]));

    writeLockfile(tmp, 'dead-session', { pid: 40061, startTimeMs: 1000 });
    recordRunnerPid({ projectDir: tmp, sessionId: 'dead-session' }, 50061, 111_000);
    mockedStartTimes.set(50061, null);

    await reapOrphanRunners(tmp, reaperDeps());

    const destructiveCalls = calls.filter(
      (call) => call.signal === 'SIGTERM' || call.signal === 'SIGKILL',
    );
    expect(destructiveCalls).toEqual([]);
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'dead-session' })).toEqual([]);
  });

  it('skips the SIGKILL escalation when the pid is recycled during the grace window', async () => {
    vi.useFakeTimers();
    tmp = createTempDir('orphan-reaper-test');
    const calls = installKillSpy(new Set([50041]));

    writeLockfile(tmp, 'dead-session', { pid: 40041, startTimeMs: 1000 });
    recordRunnerPid({ projectDir: tmp, sessionId: 'dead-session' }, 50041, 111_000);
    mockedStartTimes.set(50041, 111_000);

    const reaping = reapOrphanRunners(tmp, reaperDeps());
    // SIGTERM is sent synchronously before the grace sleep; simulate the pid
    // being recycled by an unrelated process during the window.
    mockedStartTimes.set(50041, 999_000_000);
    await vi.advanceTimersByTimeAsync(2000);
    await reaping;

    expect(calls).toContainEqual({ pid: -50041, signal: 'SIGTERM' });
    expect(calls.filter((call) => call.signal === 'SIGKILL')).toEqual([]);
    expect(readRunnerPids({ projectDir: tmp, sessionId: 'dead-session' })).toEqual([]);
  });
});
