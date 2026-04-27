import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../engine/ipc/lockfile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../engine/ipc/lockfile.js')>();
  return {
    ...actual,
    checkServerStatus: vi.fn(),
    readLockfile: vi.fn(),
  };
});

import { checkServerStatus, readLockfile } from '../../engine/ipc/lockfile.js';
import { psCommand } from './ps.js';

const mockCheckServerStatus = vi.mocked(checkServerStatus);
const mockReadLockfile = vi.mocked(readLockfile);

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `ps-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
});

describe('psCommand', () => {
  it('prints "No sessions found" when sessions directory does not exist', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await psCommand({ projectDir: testDir });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('No sessions found'),
    );

    logSpy.mockRestore();
  });

  it('prints "No sessions found" when sessions directory is empty', async () => {
    const sessionsRoot = join(testDir, '.diptych', 'sessions');
    mkdirSync(sessionsRoot, { recursive: true });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await psCommand({ projectDir: testDir });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('No sessions found'),
    );

    logSpy.mockRestore();
  });

  it('shows one row per session with correct STATUS', async () => {
    const sessionsRoot = join(testDir, '.diptych', 'sessions');
    const sessDirA = join(sessionsRoot, 'session-a');
    const sessDirB = join(sessionsRoot, 'session-b');
    mkdirSync(sessDirA, { recursive: true });
    mkdirSync(sessDirB, { recursive: true });

    const nowMs = Date.now();

    mockReadLockfile
      .mockResolvedValueOnce({
        version: 1,
        pid: 111,
        startTimeMs: nowMs - 60000,
        lastAliveMs: nowMs,
        sessionId: 'session-a',
        mode: 'standard',
        feature: 'feature A',
      })
      .mockResolvedValueOnce({
        version: 1,
        pid: 222,
        startTimeMs: nowMs - 30000,
        lastAliveMs: nowMs - 35000,
        sessionId: 'session-b',
        mode: 'quick',
        feature: 'feature B',
        exitedAt: nowMs - 5000,
        exitCode: 0,
      });

    mockCheckServerStatus
      .mockResolvedValueOnce({
        alive: true,
        data: {
          version: 1,
          pid: 111,
          startTimeMs: nowMs - 60000,
          lastAliveMs: nowMs,
          sessionId: 'session-a',
          mode: 'standard',
          feature: 'feature A',
        },
      })
      .mockResolvedValueOnce({
        alive: false,
        crashed: false,
        data: {
          version: 1,
          pid: 222,
          startTimeMs: nowMs - 30000,
          lastAliveMs: nowMs - 35000,
          sessionId: 'session-b',
          mode: 'quick',
          feature: 'feature B',
          exitedAt: nowMs - 5000,
          exitCode: 0,
        },
      });

    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });

    await psCommand({ projectDir: testDir });

    logSpy.mockRestore();

    const body = lines.slice(1); // skip header
    expect(body.length).toBe(2);
    const runningRow = body.find((l) => l.includes('session-a'));
    const exitedRow = body.find((l) => l.includes('session-b'));
    expect(runningRow).toBeDefined();
    expect(exitedRow).toBeDefined();
    expect(runningRow).toContain('running');
    expect(exitedRow).toContain('exited');
  });

  it('sorts by startTimeMs descending (newest first)', async () => {
    const sessionsRoot = join(testDir, '.diptych', 'sessions');
    // Use names that sort alphabetically: a-session (older) < b-session (newer)
    const older = join(sessionsRoot, 'a-older-session');
    const newer = join(sessionsRoot, 'b-newer-session');
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });

    const nowMs = Date.now();
    const olderStart = nowMs - 120000;
    const newerStart = nowMs - 10000;

    // readdirSync returns alphabetical: a-older-session first, b-newer-session second
    mockReadLockfile
      .mockResolvedValueOnce({
        version: 1,
        pid: 100,
        startTimeMs: olderStart,
        lastAliveMs: olderStart,
        sessionId: 'a-older-session',
        mode: 'standard',
        feature: 'older feature',
        exitedAt: nowMs - 100000,
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        version: 1,
        pid: 200,
        startTimeMs: newerStart,
        lastAliveMs: nowMs,
        sessionId: 'b-newer-session',
        mode: 'quick',
        feature: 'newer feature',
      });

    mockCheckServerStatus
      .mockResolvedValueOnce({ alive: false, crashed: false, data: null })
      .mockResolvedValueOnce({
        alive: true,
        data: {
          version: 1,
          pid: 200,
          startTimeMs: newerStart,
          lastAliveMs: nowMs,
          sessionId: 'b-newer-session',
          mode: 'quick',
          feature: 'newer feature',
        },
      });

    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });

    await psCommand({ projectDir: testDir });

    logSpy.mockRestore();

    const body = lines.slice(1);
    expect(body.length).toBe(2);
    // b-newer-session (more recent startTimeMs) should appear before a-older-session
    const newerIndex = body.findIndex((l) => l.includes('b-newer-session'));
    const olderIndex = body.findIndex((l) => l.includes('a-older-session'));
    expect(newerIndex).toBeLessThan(olderIndex);
  });

  it('ELAPSED column shows correct duration string for exited session', async () => {
    const sessionsRoot = join(testDir, '.diptych', 'sessions');
    const sessDir = join(sessionsRoot, 'timed-session');
    mkdirSync(sessDir, { recursive: true });

    const startMs = Date.now() - 5 * 60 * 1000; // 5 minutes ago
    const endMs = startMs + 2 * 60 * 1000 + 30 * 1000; // 2m 30s after start

    mockReadLockfile.mockResolvedValueOnce({
      version: 1,
      pid: 999,
      startTimeMs: startMs,
      lastAliveMs: endMs,
      sessionId: 'timed-session',
      mode: 'instant',
      feature: 'timed feature',
      exitedAt: endMs,
      exitCode: 0,
    });

    mockCheckServerStatus.mockResolvedValueOnce({
      alive: false,
      crashed: false,
      data: null,
    });

    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });

    await psCommand({ projectDir: testDir });

    logSpy.mockRestore();

    const body = lines.slice(1);
    expect(body.length).toBe(1);
    expect(body[0]).toContain('2m 30s');
  });

  it('shows crashed status correctly', async () => {
    const sessionsRoot = join(testDir, '.diptych', 'sessions');
    const sessDir = join(sessionsRoot, 'crashed-session');
    mkdirSync(sessDir, { recursive: true });

    const nowMs = Date.now();

    mockReadLockfile.mockResolvedValueOnce({
      version: 1,
      pid: 555,
      startTimeMs: nowMs - 300000,
      lastAliveMs: nowMs - 300000,
      sessionId: 'crashed-session',
      mode: 'speckit',
      feature: 'bad feature',
      signal: 'SIGKILL',
    });

    mockCheckServerStatus.mockResolvedValueOnce({
      alive: false,
      crashed: true,
      data: {
        version: 1,
        pid: 555,
        startTimeMs: nowMs - 300000,
        lastAliveMs: nowMs - 300000,
        sessionId: 'crashed-session',
        mode: 'speckit',
        feature: 'bad feature',
        signal: 'SIGKILL',
      },
    });

    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });

    await psCommand({ projectDir: testDir });

    logSpy.mockRestore();

    const body = lines.slice(1);
    expect(body.length).toBe(1);
    expect(body[0]).toContain('crashed');
  });

  it('ELAPSED column is not 0s for crashed session when lastAliveMs is after start', async () => {
    const sessionsRoot = join(testDir, '.diptych', 'sessions');
    const sessDir = join(sessionsRoot, 'elapsed-crashed');
    mkdirSync(sessDir, { recursive: true });

    const startMs = Date.now() - 120000; // 2 minutes ago
    const lastAliveMs = startMs + 90000; // 90 seconds after start

    mockReadLockfile.mockResolvedValueOnce({
      version: 1,
      pid: 777,
      startTimeMs: startMs,
      lastAliveMs,
      sessionId: 'elapsed-crashed',
      mode: 'standard',
      feature: 'elapsed feature',
      signal: 'SIGTERM',
    });

    mockCheckServerStatus.mockResolvedValueOnce({
      alive: false,
      crashed: true,
      data: {
        version: 1,
        pid: 777,
        startTimeMs: startMs,
        lastAliveMs,
        sessionId: 'elapsed-crashed',
        mode: 'standard',
        feature: 'elapsed feature',
        signal: 'SIGTERM',
      },
    });

    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });

    await psCommand({ projectDir: testDir });

    logSpy.mockRestore();

    const body = lines.slice(1);
    expect(body.length).toBe(1);
    // elapsed should be ~1m 30s, definitely not a zero elapsed (which would show just "0s")
    expect(body[0]).toMatch(/1m\s+\d+s/);
    expect(body[0]).not.toMatch(/^\s*0s\s/);
    expect(body[0]).toContain('1m');
  });

  it('throws cliError with exit code 1 on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    await expect(psCommand({ projectDir: testDir })).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('not supported on Windows'),
    });
  });
});
