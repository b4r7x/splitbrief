import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const control = vi.hoisted(() => ({ failWrite: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (...args: Parameters<typeof actual.writeFile>) => {
      if (control.failWrite) {
        return Promise.reject(
          Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }),
        );
      }
      return actual.writeFile(...args);
    },
  };
});

const { startHeartbeat } = await import('./heartbeat.js');
const { writeLockfile, readLockfile } = await import('./lockfile.js');
const { HEARTBEAT_INTERVAL_MS } = await import('../constants.js');

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
  testDir = join(tmpdir(), `heartbeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

// The heartbeat tick kicks off a real fs read+write chain (readFile → writeFile →
// rename → chmod). Fake timers only fire the interval callback; they do not drive
// the libuv IO to completion. After advancing the fake clock we switch to real
// timers and yield to the macrotask queue until the in-flight chains settle. Each
// queued tick needs several event-loop turns, so we drain generously.
async function drainIo(): Promise<void> {
  vi.useRealTimers();
  for (let i = 0; i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('startHeartbeat', () => {
  it('refreshes lastAliveMs on a tick against a healthy lockfile', async () => {
    await seedLockfile();
    const seeded = (await readLockfile(testDir))!.lastAliveMs;
    vi.useFakeTimers();

    const stop = startHeartbeat(testDir);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
    await drainIo();
    stop();

    const data = await readLockfile(testDir);
    expect(data).not.toBeNull();
    expect(data!.lastAliveMs).toBeGreaterThan(seeded);
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
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);
    await drainIo();
    stop();

    process.off('unhandledRejection', onRejection);

    expect(rejections).toEqual([]);
    const warnings = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('heartbeat write failed'),
    );
    expect(warnings.length).toBe(1);
  });
});
