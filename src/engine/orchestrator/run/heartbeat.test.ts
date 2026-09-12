import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const control = vi.hoisted(() => ({ failWrite: false, failedWrites: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      if (control.failWrite) {
        control.failedWrites += 1;
        return Promise.reject(
          Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
        );
      }
      return actual.writeFile(...args);
    },
  };
});

const { startHeartbeat, LOCKFILE_PING_INTERVAL_MS } = await import('./heartbeat.js');
const { writeLockfile, readLockfile, updateHeartbeat } = await import(
  '../../../core/sessions/lockfile.js'
);

// A tick kicks off a real fs chain (stat → readFile → lstat → writeFile → rename).
// Fake timers fire the interval callback but do not drive that IO to completion, and no
// fixed number of event-loop turns can: turns are cheap, fs latency is not, so the turn
// count that settles the chain on an idle machine is not the count that settles it on a
// loaded one. Both tests below wait on an observable end state, not on a turn budget.
const SETTLE_TIMEOUT_MS = 5_000;
const FAILING_TICKS = 5;

let testDir: string;

function sessionIdFor(dir: string): string {
  return basename(dir);
}

async function seedLockfile(): Promise<void> {
  await writeLockfile(testDir, {
    pid: 1234,
    startTimeMs: 1000,
    lastAliveMs: 1000,
    sessionId: sessionIdFor(testDir),
    mode: 'standard',
    feature: 'test feature',
  });
}

beforeEach(() => {
  control.failWrite = false;
  control.failedWrites = 0;
  testDir = join(tmpdir(), `heartbeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('startHeartbeat', () => {
  it('refreshes lastAliveMs on a tick against a healthy lockfile', async () => {
    await seedLockfile();
    const seeded = readLockfile(testDir)!.lastAliveMs;
    vi.useFakeTimers();

    const stop = startHeartbeat(testDir);
    await vi.advanceTimersByTimeAsync(LOCKFILE_PING_INTERVAL_MS);
    vi.useRealTimers();

    await vi.waitFor(
      async () => {
        const data = readLockfile(testDir);
        expect(data).not.toBeNull();
        expect(data?.lastAliveMs ?? 0).toBeGreaterThan(seeded);
      },
      { timeout: SETTLE_TIMEOUT_MS, interval: 10 },
    );

    stop();
  });

  it('survives a persistent write failure: no unhandled rejection and a single warning', async () => {
    await seedLockfile();
    control.failWrite = true;

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    vi.useFakeTimers();
    const stop = startHeartbeat(testDir);
    await vi.advanceTimersByTimeAsync(LOCKFILE_PING_INTERVAL_MS * FAILING_TICKS);
    vi.useRealTimers();

    // Every tick queues its read-modify-write on the per-session chain inside
    // `updateLockfile`, so one more call queues behind all of them: awaiting it is
    // reached only once every in-flight tick has settled and had its chance to warn.
    await updateHeartbeat(testDir);
    stop();

    process.off('unhandledRejection', onRejection);

    // Each tick and the barrier call above hit the failing write, so the single warning
    // below is a once-only claim over six failures, not an artifact of stopping early.
    expect(control.failedWrites).toBe(FAILING_TICKS + 1);
    expect(rejections).toEqual([]);
    const warnings = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('heartbeat write failed'),
    );
    expect(warnings.length).toBe(1);
  });
});
