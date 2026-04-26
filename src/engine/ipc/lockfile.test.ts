import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeLockfile,
  updateHeartbeat,
  markExited,
  markCrashed,
  readLockfile,
  checkServerStatus,
} from './lockfile.js';
import { HEARTBEAT_STALENESS_MS } from './heartbeat.js';

let testDir: string;

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
      sessionId: 'test-session',
      mode: 'standard',
      feature: 'test feature',
    });

    const data = await readLockfile(testDir);
    expect(data).not.toBeNull();
    expect(data!.version).toBe(1);
    expect(data!.pid).toBe(1234);
    expect(data!.sessionId).toBe('test-session');
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
      sessionId: 'test-session',
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
});

describe('markExited', () => {
  it('adds exitedAt and exitCode', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: 'test-session',
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

describe('markCrashed', () => {
  it('adds signal and cause', async () => {
    await writeLockfile(testDir, {
      pid: 1234,
      startTimeMs: 1000,
      lastAliveMs: 1000,
      sessionId: 'test-session',
      mode: 'standard',
      feature: 'test feature',
    });

    await markCrashed(testDir, 'uncaught', 'Something went wrong');
    const data = await readLockfile(testDir);
    expect(data).not.toBeNull();
    expect(data!.signal).toBe('uncaught');
    expect(data!.cause).toBe('Something went wrong');
  });
});

describe('readLockfile', () => {
  it('returns null when file does not exist', async () => {
    const result = await readLockfile(testDir);
    expect(result).toBeNull();
  });
});

describe('checkServerStatus', () => {
  it('returns alive:false crashed:false data:null when no lockfile', async () => {
    const status = await checkServerStatus(testDir);
    expect(status).toEqual({ alive: false, crashed: false, data: null });
  });

  it('returns alive:false crashed:false when lockfile has exitedAt', async () => {
    await writeLockfile(testDir, {
      pid: 99999,
      startTimeMs: 1000,
      lastAliveMs: Date.now(),
      sessionId: 'test-session',
      mode: 'standard',
      feature: 'test feature',
    });
    await markExited(testDir, 0);

    const status = await checkServerStatus(testDir);
    expect(status.alive).toBe(false);
    expect((status as { alive: false; crashed: boolean; data: unknown }).crashed).toBe(false);
  });

  it('returns alive:false crashed:true when lastAliveMs is stale', async () => {
    // Use a non-existent PID so kill(pid, 0) throws; test staleness path regardless
    await writeLockfile(testDir, {
      pid: 99999999,
      startTimeMs: 1000,
      lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1000,
      sessionId: 'test-session',
      mode: 'standard',
      feature: 'test feature',
    });

    const status = await checkServerStatus(testDir);
    expect(status.alive).toBe(false);
    expect((status as { alive: false; crashed: boolean; data: unknown }).crashed).toBe(true);
  });

  it('(integration) returns alive:true for current process PID with fresh lockfile', async () => {
    const now = Date.now();
    await writeLockfile(testDir, {
      pid: process.pid,
      startTimeMs: now,
      lastAliveMs: now,
      sessionId: 'test-session',
      mode: 'standard',
      feature: 'test feature',
    });

    const status = await checkServerStatus(testDir);
    expect(status.alive).toBe(true);
  });
});
