import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const control = vi.hoisted(() => ({ perturbReads: false, reads: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const content = await actual.readFile(...args);
      if (!control.perturbReads) return content;
      control.reads += 1;
      return control.reads % 2 === 0 ? `${String(content)} ` : content;
    },
  };
});

const {
  writeLockfile,
  updateHeartbeat,
  markExited,
  readLockfile,
  confinedReadLockfile,
  checkSessionLiveness,
} = await import('./lockfile.js');
const { HEARTBEAT_STALENESS_MS } = await import('./lockfile-status.js');

let testDir: string;

function sessionIdFor(dir: string): string {
  return basename(dir);
}

function writeRawLockfile(data: Record<string, unknown>): void {
  writeFileSync(join(testDir, 'lockfile.json'), JSON.stringify(data));
}

beforeEach(() => {
  control.perturbReads = false;
  control.reads = 0;
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

    const data = readLockfile(testDir);
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
    const data = readLockfile(testDir);
    expect(data).not.toBeNull();
    expect(data!.lastAliveMs).toBeGreaterThanOrEqual(before);
    expect(data!.pid).toBe(1234);
    expect(data!.startTimeMs).toBe(1000);
  });

  it('warns once when the compare-and-swap never settles instead of failing silently', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    // Every second read returns different bytes, so an out-of-process writer appears to
    // rewrite the lockfile under every attempt and the non-mustWin update gives up.
    control.perturbReads = true;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await updateHeartbeat(testDir);
    control.perturbReads = false;

    const warnings = stderrSpy.mock.calls.filter((call) =>
      String(call[0]).includes('heartbeat write failed'),
    );
    stderrSpy.mockRestore();
    expect(warnings.length).toBe(1);
    expect(readLockfile(testDir)!.lastAliveMs).toBe(1000);
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
    const before = readLockfile(testDir);
    const exitedAtBefore = before!.exitedAt;

    await updateHeartbeat(testDir);

    const after = readLockfile(testDir);
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
    const data = readLockfile(testDir);
    expect(data).not.toBeNull();
    expect(data!.exitedAt).toBeDefined();
    expect(data!.exitCode).toBe(0);
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
    const before = readLockfile(testDir);
    await markExited(testDir, 130);
    const after = readLockfile(testDir);
    expect(after!.exitedAt).toBe(before!.exitedAt);
    expect(after!.exitCode).toBe(130);
  });
});

describe('exit record vs concurrent heartbeat (CAS)', () => {
  it('a heartbeat that read the file before the exit was recorded cannot erase exitedAt', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    // Worst-case interleaving: the heartbeat tick begins its read-modify-rewrite, then the
    // exit handler records exitedAt before the heartbeat's write lands. The CAS must detect
    // the concurrent write, re-read, and refuse to clobber the exit record.
    const heartbeat = updateHeartbeat(testDir);
    const exit = markExited(testDir, 3);
    await Promise.all([heartbeat, exit]);

    const after = readLockfile(testDir);
    expect(after!.exitedAt).toBeDefined();
    expect(after!.exitCode).toBe(3);
  });

  it('keeps the exit record across repeated concurrent heartbeats', async () => {
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

      await Promise.all([updateHeartbeat(dir), markExited(dir, 3), updateHeartbeat(dir)]);

      const after = readLockfile(dir);
      expect(after!.exitedAt, `iteration ${i}`).toBeDefined();
      expect(after!.exitCode, `iteration ${i}`).toBe(3);
    }
  });
});

describe('readLockfile', () => {
  it('returns null when file does not exist', async () => {
    const result = readLockfile(testDir);
    expect(result).toBeNull();
  });

  it('returns null (not a raw ENOENT) when the session directory does not exist', async () => {
    const missingDir = join(testDir, 'nonexistent-session');
    expect(existsSync(missingDir)).toBe(false);
    expect(readLockfile(missingDir)).toBeNull();
    expect(confinedReadLockfile(missingDir, 'nonexistent-session')).toBeNull();
  });

  it('returns null for corrupt JSON', async () => {
    writeFileSync(join(testDir, 'lockfile.json'), 'not-json{{{');
    const result = readLockfile(testDir);
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
    const result = readLockfile(testDir);
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
    const result = readLockfile(testDir);
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

    expect(readLockfile(testDir)).toBeNull();
    expect(confinedReadLockfile(testDir, sessionIdFor(testDir))).toBeNull();
  });
});

describe('checkSessionLiveness', () => {
  it('returns alive:false data:null when no lockfile', () => {
    expect(checkSessionLiveness(testDir)).toEqual({ alive: false, data: null });
  });

  it('returns the not-found status when the session directory does not exist', () => {
    const missingDir = join(testDir, 'nonexistent-session');
    expect(existsSync(missingDir)).toBe(false);
    expect(checkSessionLiveness(missingDir)).toEqual({ alive: false, data: null });
  });

  it('returns alive:false data:null when the lockfile schema is invalid', () => {
    writeRawLockfile({
      version: 1,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    expect(checkSessionLiveness(testDir)).toEqual({ alive: false, data: null });
  });

  it('returns alive:false data:null when the lockfile names another session', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: Date.now(),
      sessionId: 'wrong-session-id',
      mode: 'standard',
      feature: 'test feature',
    });

    expect(checkSessionLiveness(testDir)).toEqual({ alive: false, data: null });
  });

  it('reports an exited session as neither alive nor an unresponsive process', async () => {
    await writeLockfile(testDir, {
      pid: 99999,
      startTimeMs: 1000,
      lastAliveMs: Date.now(),
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });
    await markExited(testDir, 0);

    const status = checkSessionLiveness(testDir);
    expect(status.alive).toBe(false);
    expect((status as { alive: false; processAlive?: boolean }).processAlive).toBeUndefined();
  });

  it('returns alive:false processAlive:false when the pid is dead and stale', async () => {
    // Use a non-existent PID so kill(pid, 0) throws; test staleness path regardless
    await writeLockfile(testDir, {
      pid: 99999999,
      startTimeMs: 1000,
      lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1000,
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    const status = checkSessionLiveness(testDir);
    expect(status.alive).toBe(false);
    expect((status as { alive: false; processAlive?: boolean }).processAlive).toBe(false);
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

    const status = checkSessionLiveness(testDir);
    expect(status.alive).toBe(false);
    expect(status as { alive: false; processAlive?: boolean; data: unknown }).toMatchObject({
      processAlive: true,
    });
  });

  it('returns processAlive:false when the pid belongs to a different process start time', () => {
    writeRawLockfile({
      version: 1,
      pid: process.pid,
      startTimeMs: 1,
      lastAliveMs: Date.now(),
      sessionId: sessionIdFor(testDir),
      mode: 'standard',
      feature: 'test feature',
    });

    expect(checkSessionLiveness(testDir)).toMatchObject({ alive: false, processAlive: false });
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

    const status = checkSessionLiveness(testDir);
    expect(status.alive).toBe(true);
  });
});
