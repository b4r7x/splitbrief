import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { psCommand, type PsDeps } from './ps.js';
import type { LockfileData, ServerStatus } from '../../engine/ipc/lockfile.js';

let testDir: string;
const originalPlatform = process.platform;
const lockfiles = new Map<string, LockfileData | null>();
const statuses = new Map<string, ServerStatus>();

const fakeDeps: PsDeps = {
  readLockfile: async (sessionDir) => lockfiles.get(sessionDir) ?? null,
  checkServerStatus: async (sessionDir) => {
    return statuses.get(sessionDir) ?? { alive: false, crashed: false, data: null };
  },
};

function putSession(
  sessionId: string,
  data: LockfileData | null,
  status: ServerStatus = { alive: false, crashed: false, data },
): void {
  const sessDir = join(testDir, '.diptych', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  lockfiles.set(sessDir, data);
  statuses.set(sessDir, status);
}

async function collectPsOutput(): Promise<string[]> {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    lines.push(line);
  });

  await psCommand({ projectDir: testDir }, fakeDeps);
  return lines;
}

beforeEach(() => {
  testDir = join(tmpdir(), `ps-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  lockfiles.clear();
  statuses.clear();
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe('psCommand', () => {
  it('prints "No sessions found" when sessions directory does not exist', async () => {
    const lines = await collectPsOutput();

    expect(lines).toEqual([expect.stringContaining('No sessions found')]);
  });

  it('prints "No sessions found" when sessions directory is empty', async () => {
    mkdirSync(join(testDir, '.diptych', 'sessions'), { recursive: true });

    const lines = await collectPsOutput();

    expect(lines).toEqual([expect.stringContaining('No sessions found')]);
  });

  it('shows one row per session with correct STATUS', async () => {
    const nowMs = Date.now();
    const sessionA: LockfileData = {
      version: 1,
      pid: 111,
      startTimeMs: nowMs - 60000,
      lastAliveMs: nowMs,
      sessionId: 'session-a',
      mode: 'standard',
      feature: 'feature A',
    };
    const sessionB: LockfileData = {
      version: 1,
      pid: 222,
      startTimeMs: nowMs - 30000,
      lastAliveMs: nowMs - 35000,
      sessionId: 'session-b',
      mode: 'quick',
      feature: 'feature B',
      exitedAt: nowMs - 5000,
      exitCode: 0,
    };
    putSession('session-a', sessionA, { alive: true, data: sessionA });
    putSession('session-b', sessionB, { alive: false, crashed: false, data: sessionB });

    const lines = await collectPsOutput();

    const body = lines.slice(1);
    expect(body).toHaveLength(2);
    expect(body.find((line) => line.includes('session-a'))).toContain('running');
    expect(body.find((line) => line.includes('session-b'))).toContain('exited');
  });

  it('sorts by startTimeMs descending', async () => {
    const nowMs = Date.now();
    const olderStart = nowMs - 120000;
    const newerStart = nowMs - 10000;
    const older: LockfileData = {
      version: 1,
      pid: 100,
      startTimeMs: olderStart,
      lastAliveMs: olderStart,
      sessionId: 'a-older-session',
      mode: 'standard',
      feature: 'older feature',
      exitedAt: nowMs - 100000,
      exitCode: 0,
    };
    const newer: LockfileData = {
      version: 1,
      pid: 200,
      startTimeMs: newerStart,
      lastAliveMs: nowMs,
      sessionId: 'b-newer-session',
      mode: 'quick',
      feature: 'newer feature',
    };
    putSession('a-older-session', older, { alive: false, crashed: false, data: older });
    putSession('b-newer-session', newer, { alive: true, data: newer });

    const lines = await collectPsOutput();

    const body = lines.slice(1);
    expect(body).toHaveLength(2);
    expect(body[0]).toContain('b-newer-session');
    expect(body[1]).toContain('a-older-session');
  });

  it('only displays numeric aliases for sessions the alias resolver can resolve', async () => {
    const nowMs = Date.now();
    const data: LockfileData = {
      version: 1,
      pid: 100,
      startTimeMs: nowMs,
      lastAliveMs: nowMs,
      sessionId: 'aliased-session',
      mode: 'standard',
      feature: 'aliased feature',
    };
    putSession('aliased-session', data, { alive: true, data });
    putSession('unknown-session', null);

    const lines = await collectPsOutput();

    expect(lines.find(line => line.includes('aliased-session'))?.trimStart()).toMatch(/^1\s/);
    expect(lines.find(line => line.includes('unknown-session'))?.trimStart()).toMatch(/^-\s/);
  });

  it('ELAPSED column shows correct duration string for exited session', async () => {
    const startMs = Date.now() - 5 * 60 * 1000;
    const endMs = startMs + 2 * 60 * 1000 + 30 * 1000;
    const data: LockfileData = {
      version: 1,
      pid: 999,
      startTimeMs: startMs,
      lastAliveMs: endMs,
      sessionId: 'timed-session',
      mode: 'instant',
      feature: 'timed feature',
      exitedAt: endMs,
      exitCode: 0,
    };
    putSession('timed-session', data, { alive: false, crashed: false, data: null });

    const lines = await collectPsOutput();

    expect(lines[1]).toContain('2m 30s');
  });

  it('shows crashed status correctly', async () => {
    const nowMs = Date.now();
    const data: LockfileData = {
      version: 1,
      pid: 555,
      startTimeMs: nowMs - 300000,
      lastAliveMs: nowMs - 300000,
      sessionId: 'crashed-session',
      mode: 'speckit',
      feature: 'bad feature',
      signal: 'SIGKILL',
    };
    putSession('crashed-session', data, { alive: false, crashed: true, data });

    const lines = await collectPsOutput();

    expect(lines[1]).toContain('crashed');
  });

  it('ELAPSED column is not 0s for crashed session when lastAliveMs is after start', async () => {
    const startMs = Date.now() - 120000;
    const lastAliveMs = startMs + 90000;
    const data: LockfileData = {
      version: 1,
      pid: 777,
      startTimeMs: startMs,
      lastAliveMs,
      sessionId: 'elapsed-crashed',
      mode: 'standard',
      feature: 'elapsed feature',
      signal: 'SIGTERM',
    };
    putSession('elapsed-crashed', data, { alive: false, crashed: true, data });

    const lines = await collectPsOutput();

    expect(lines[1]).toMatch(/1m\s+\d+s/);
    expect(lines[1]).not.toMatch(/^\s*0s\s/);
    expect(lines[1]).toContain('1m');
  });

  it('throws cliError with exit code 1 on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    await expect(psCommand({ projectDir: testDir }, fakeDeps)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('not supported on Windows'),
    });
  });
});
