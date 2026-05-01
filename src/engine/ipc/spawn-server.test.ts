import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { IPC_SOCK_FILE, LOCKFILE } from '../../core/paths.js';
import { HEARTBEAT_STALENESS_MS } from './constants.js';
import { writeLockfile } from './lockfile.js';

// Mock child_process before importing spawn-server
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { spawn } from 'node:child_process';
import { spawnServer } from './spawn-server.js';

const mockSpawn = vi.mocked(spawn);

function makeChild(pid = 12345) {
  return {
    pid,
    unref: vi.fn(),
    on: vi.fn(),
    stdout: null,
    stderr: null,
    stdin: null,
  } as unknown as ReturnType<typeof spawn>;
}

let testDir: string;
let socketServer: Server | null = null;

async function listenOnSocket(sockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socketServer = createServer();
    socketServer.once('error', reject);
    socketServer.listen(sockPath, resolve);
  });
}

function closeSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!socketServer) { resolve(); return; }
    socketServer.close(() => resolve());
    socketServer = null;
  });
}

function currentProcessStartTimeMs(): number {
  const raw = execSync(`ps -o lstart= -p ${process.pid}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

async function writeServerLockfile(overrides?: Partial<Parameters<typeof writeLockfile>[1]>): Promise<void> {
  const now = Date.now();
  await writeLockfile(testDir, {
    pid: process.pid,
    startTimeMs: currentProcessStartTimeMs(),
    lastAliveMs: now,
    sessionId: 'test-session',
    mode: 'standard',
    feature: 'test feature',
    ...overrides,
  });
}

beforeEach(() => {
  testDir = join(tmpdir(), `spawn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await closeSocketServer();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('spawnServer', () => {
  it('returns { ok: true } when the real lockfile is alive and the socket accepts connections', async () => {
    const child = makeChild(42);
    mockSpawn.mockReturnValue(child);

    await writeServerLockfile();
    await listenOnSocket(join(testDir, IPC_SOCK_FILE));

    const result = await spawnServer({
      sessionDir: testDir,
      sessionId: 'test-session',
      projectDir: '/tmp/project',
      feature: 'test feature',
      mode: 'standard',
      configPath: '/tmp/project/.diptych/config.yaml',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(process.pid);
      expect(result.sessionId).toBe('test-session');
    }
  });

  it('returns { ok: false, reason: "timeout..." } when lockfile never appears', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const child = makeChild(99);
    mockSpawn.mockReturnValue(child);

    rmSync(join(testDir, LOCKFILE), { force: true });

    const resultPromise = spawnServer({
      sessionDir: testDir,
      sessionId: 'test-session',
      projectDir: '/tmp/project',
      feature: 'test feature',
      mode: 'standard',
      configPath: '/tmp/project/.diptych/config.yaml',
    });

    // Advance past the 3s timeout (poll every 200ms, 3000ms total)
    await vi.runAllTimersAsync();

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('timeout');
    }
  });

  it('returns { ok: false, reason: "timeout..." } when the real lockfile heartbeat is stale', async () => {
    const child = makeChild(88);
    mockSpawn.mockReturnValue(child);

    await writeServerLockfile({
      lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1,
    });

    const resultPromise = spawnServer({
      sessionDir: testDir,
      sessionId: 'test-session',
      projectDir: '/tmp/project',
      feature: 'test feature',
      mode: 'standard',
      configPath: '/tmp/project/.diptych/config.yaml',
    });

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('timeout');
    }
  });

  it('spawned child has detached: true', async () => {
    const child = makeChild(77);
    mockSpawn.mockReturnValue(child);

    await writeServerLockfile({
      sessionId: 'session',
      mode: 'instant',
      feature: 'feature',
    });
    await listenOnSocket(join(testDir, IPC_SOCK_FILE));

    await spawnServer({
      sessionDir: testDir,
      sessionId: 'session',
      projectDir: '/tmp/project',
      feature: 'feature',
      mode: 'instant',
      configPath: '/tmp/project/.diptych/config.yaml',
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: true }),
    );
  });
});
