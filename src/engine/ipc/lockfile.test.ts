import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeLockfile,
  updateHeartbeat,
  markExited,
  markCrashed,
  markSignaled,
  readLockfile,
  confinedReadLockfile,
  checkServerStatus,
} from './lockfile.js';
import { HEARTBEAT_STALENESS_MS } from '../../core/sessions/lockfile-status.js';

let testDir: string;

function sessionIdFor(dir: string): string {
  return basename(dir);
}

function writeRawLockfile(data: Record<string, unknown>): void {
  writeFileSync(join(testDir, 'lockfile.json'), JSON.stringify(data));
}

beforeEach(() => {
  testDir = join(tmpdir(), `lockfile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('writeLockfile', () => {
  it('creates a valid JSON file with version: 1', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    const data = await readLockfile(testDir);
    expect(data).not.toBeNull();
    expect(data!.version).toBe(1);
    expect(data!.pid).toBe(1234);
    expect(data!.sessionId).toBe(sessionIdFor(testDir));
    expect(data!.mode).toBe('standard');
    expect(data!.feature).toBe('test feature');
  });
});

describe('updateHeartbeat', () => {
  it('updates only lastAliveMs', async () => {
    const before = Date.now();
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    await updateHeartbeat(testDir);
    const data = await readLockfile(testDir);
    expect(data).not.toBeNull();
    expect(data!.lastAliveMs).toBeGreaterThanOrEqual(before);
    expect(data!.pid).toBe(1234);
    expect(data!.startTimeMs).toBe(1000);
  });

  it('does not overwrite exitedAt after markExited', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });
    await markExited(testDir, 0);
    const before = await readLockfile(testDir);
    const exitedAtBefore = before!.exitedAt;

    await updateHeartbeat(testDir);

    const after = await readLockfile(testDir);
    expect(after!.exitedAt).toBe(exitedAtBefore);
    expect(after!.lastAliveMs).toBe(1000);
  });
});

describe('markExited', () => {
  it('adds exitedAt and exitCode', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    await markExited(testDir, 0);
    const data = await readLockfile(testDir);
    expect(data).not.toBeNull();
    expect(data!.exitedAt).toBeDefined();
    expect(data!.exitCode).toBe(0);
  });
});

describe('exit/crash record vs concurrent heartbeat (CAS)', () => {
  it('a heartbeat that read the file before the crash was recorded cannot erase exitedAt', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    // Worst-case interleaving: the heartbeat tick begins its read-modify-rewrite, then the
    // crash handler records exitedAt before the heartbeat's write lands. The CAS must detect
    // the concurrent write, re-read, and refuse to clobber the crash record.
    const heartbeat = updateHeartbeat(testDir);
    const crash = markCrashed(testDir, 'uncaught', 'boom');
    await Promise.all([heartbeat, crash]);

    const after = await readLockfile(testDir);
    expect(after!.exitedAt).toBeDefined();
    expect(after!.signal).toBe('uncaught');
    expect(after!.cause).toBe('boom');
  });

  it('keeps the crash record across repeated concurrent heartbeats', async () => {
    for (let i = 0; i < 25; i++) {
      const dir = join(testDir, `iter-${i}`);
      mkdirSync(dir, { recursive: true });
      await writeLockfile(dir, {
        pid: 1234,
        startTimeMs: 1000,
        lastAliveMs: 1000,
        sessionId: basename(dir),
        mode: 'standard',
        feature: 'test feature',
      });

      await Promise.all([
        updateHeartbeat(dir),
        markCrashed(dir, 'uncaught', 'boom'),
        updateHeartbeat(dir),
      ]);

      const after = await readLockfile(dir);
      expect(after!.exitedAt, `iteration ${i}`).toBeDefined();
      expect(after!.signal, `iteration ${i}`).toBe('uncaught');
    }
  });
});

describe('markCrashed', () => {
  it('adds signal and cause', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    await markCrashed(testDir, 'uncaught', 'Something went wrong');
    const data = await readLockfile(testDir);
    expect(data).not.toBeNull();
    expect(data!.signal).toBe('uncaught');
    expect(data!.cause).toBe('Something went wrong');
  });

  it('sets exitedAt so heartbeat will not race-overwrite', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    await markCrashed(testDir, 'uncaught', 'boom');
    const before = await readLockfile(testDir);
    expect(before!.exitedAt).toBeDefined();

    await updateHeartbeat(testDir);
    const after = await readLockfile(testDir);
    expect(after!.exitedAt).toBe(before!.exitedAt);
    expect(after!.lastAliveMs).toBe(1000);
  });
});

describe('markSignaled', () => {
  it('records signal name and exitedAt for SIGTERM/SIGINT shutdown', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    await markSignaled(testDir, 'SIGTERM');
    const data = await readLockfile(testDir);
    expect(data!.signal).toBe('SIGTERM');
    expect(data!.exitedAt).toBeDefined();
  });

  it('does not overwrite exitedAt if already set', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    await markExited(testDir, 0);
    const before = await readLockfile(testDir);
    await markSignaled(testDir, 'SIGINT');
    const after = await readLockfile(testDir);
    expect(after!.exitedAt).toBe(before!.exitedAt);
    expect(after!.signal).toBe('SIGINT');
  });
});

describe('readLockfile', () => {
  it('returns null when file does not exist', async () => {
    const result = await readLockfile(testDir);
    expect(result).toBeNull();
  });

  it('returns null (not a raw ENOENT) when the session directory does not exist', async () => {
    const missingDir = join(testDir, 'nonexistent-session');
    expect(existsSync(missingDir)).toBe(false);
    await expect(readLockfile(missingDir)).resolves.toBeNull();
    await expect(confinedReadLockfile(missingDir, 'nonexistent-session')).resolves.toBeNull();
  });

  it('returns null for corrupt JSON', async () => {
    writeFileSync(join(testDir, 'lockfile.json'), 'not-json{{{');
    const result = await readLockfile(testDir);
    expect(result).toBeNull();
  });

  it('returns null when required fields are missing (pid missing)', async () => {
    const bad = {
      version: 1,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: 'x',
      mode: 'standard',
      feature: 'f',
    };
    writeRawLockfile(bad);
    const result = await readLockfile(testDir);
    expect(result).toBeNull();
  });

  it('returns null when pid is not a positive integer', async () => {
    const bad = {
      version: 1,
      pid: -1,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: 'x',
      mode: 'standard',
      feature: 'f',
    };
    writeRawLockfile(bad);
    const result = await readLockfile(testDir);
    expect(result).toBeNull();
  });

  it('returns null when lockfile sessionId does not match session directory', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: 'wrong-session-id',
      mode: 'standard',
      feature: 'test feature',
    });

    expect(await readLockfile(testDir)).toBeNull();
    expect(await confinedReadLockfile(testDir, sessionIdFor(testDir))).toBeNull();
  });
});

describe('checkServerStatus', () => {
  it('returns alive:false crashed:false data:null when no lockfile', async () => {
    const status = await checkServerStatus(testDir);
    expect(status).toEqual({ alive: false, crashed: false, data: null });
  });

  it('returns the not-found status when the session directory does not exist', async () => {
    const missingDir = join(testDir, 'nonexistent-session');
    expect(existsSync(missingDir)).toBe(false);
    const status = await checkServerStatus(missingDir);
    expect(status).toEqual({ alive: false, crashed: false, data: null });
  });

  it('returns alive:false crashed:false when the lockfile schema is invalid', async () => {
    writeRawLockfile({
      version: 1,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    const status = await checkServerStatus(testDir);
    expect(status).toEqual({ alive: false, crashed: false, data: null });
  });

  it('returns alive:false crashed:false when the lockfile names another session', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: Date.now(),
      sessionId: 'wrong-session-id',
      mode: 'standard',
      feature: 'test feature',
    });

    const status = await checkServerStatus(testDir);
    expect(status).toEqual({ alive: false, crashed: false, data: null });
  });

  it('returns alive:false crashed:false when lockfile has exitedAt', async () => {
    await writeLockfile(testDir, {
      pid: 99999,
      startTimeMs: 1000,
      lastAliveMs: Date.now(),
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });
    await markExited(testDir, 0);

    const status = await checkServerStatus(testDir);
    expect(status.alive).toBe(false);
    expect((status as { alive: false; crashed: boolean; data: unknown }).crashed).toBe(false);
  });

  it('returns alive:false crashed:true processAlive:false when the pid is dead and stale', async () => {
    // Use a non-existent PID so kill(pid, 0) throws; test staleness path regardless
    await writeLockfile(testDir, {
      pid: 99999999,
      startTimeMs: 1000,
      lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    const status = await checkServerStatus(testDir);
    expect(status.alive).toBe(false);
    const narrowed = status as {
      alive: false;
      crashed: boolean;
      processAlive?: boolean;
      data: unknown;
    };
    expect(narrowed.crashed).toBe(true);
    expect(narrowed.processAlive).toBeFalsy();
  });

  it('returns processAlive:true (not a crash) when the pid is verified live but the heartbeat is stale', async () => {
    // The current process is provably alive; a stale heartbeat must surface as an unresponsive
    // live process, NOT be conflated with a crash that licenses resuming a second orchestrator.
    const now = Date.now();
    await writeLockfile(testDir, {
      pid: process.pid,
      startTimeMs: now,
      lastAliveMs: now - HEARTBEAT_STALENESS_MS - 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    const status = await checkServerStatus(testDir);
    expect(status.alive).toBe(false);
    expect(
      status as { alive: false; crashed: boolean; processAlive?: boolean; data: unknown },
    ).toMatchObject({ processAlive: true });
  });

  it('returns alive:false crashed:true when the pid belongs to a different process start time', async () => {
    writeRawLockfile({
      version: 1,
      pid: process.pid,
      startTimeMs: 1,
      lastAliveMs: Date.now(),
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    const status = await checkServerStatus(testDir);
    expect(status).toMatchObject({ alive: false, crashed: true, processAlive: false });
  });

  it('(integration) returns alive:true for current process PID with fresh lockfile', async () => {
    const now = Date.now();
    await writeLockfile(testDir, {
      pid: process.pid,
      startTimeMs: now,
      lastAliveMs: now,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    const status = await checkServerStatus(testDir);
    expect(status.alive).toBe(true);
  });
});
