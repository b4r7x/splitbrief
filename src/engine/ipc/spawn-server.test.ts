import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';

// Mock child_process before importing spawn-server
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

// Mock lockfile module to control checkServerStatus
vi.mock('./lockfile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lockfile.js')>();
  return {
    ...actual,
    checkServerStatus: vi.fn(),
  };
});

import { spawn } from 'node:child_process';
import { checkServerStatus } from './lockfile.js';
import { spawnServer } from './spawn-server.js';

const mockSpawn = vi.mocked(spawn);
const mockCheckServerStatus = vi.mocked(checkServerStatus);

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
  it('returns { ok: true } when checkServerStatus returns alive', async () => {
    const child = makeChild(42);
    mockSpawn.mockReturnValue(child);

    await listenOnSocket(join(testDir, 'ipc.sock'));
    mockCheckServerStatus.mockResolvedValue({
      alive: true,
      data: {
        version: 1,
        pid: 42,
        startTimeMs: Date.now(),
        lastAliveMs: Date.now(),
        sessionId: 'test-session',
        mode: 'standard',
        feature: 'test feature',
      },
    });

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
      expect(result.pid).toBe(42);
      expect(result.sessionId).toBe('test-session');
    }
  });

  it('returns { ok: false, reason: "timeout..." } when lockfile never appears', async () => {
    vi.useFakeTimers();

    const child = makeChild(99);
    mockSpawn.mockReturnValue(child);

    mockCheckServerStatus.mockResolvedValue({
      alive: false,
      crashed: false,
      data: null,
    });

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

  it('spawned child has detached: true', async () => {
    const child = makeChild(77);
    mockSpawn.mockReturnValue(child);

    await listenOnSocket(join(testDir, 'ipc.sock'));
    mockCheckServerStatus.mockResolvedValue({
      alive: true,
      data: {
        version: 1,
        pid: 77,
        startTimeMs: Date.now(),
        lastAliveMs: Date.now(),
        sessionId: 'session',
        mode: 'instant',
        feature: 'feature',
      },
    });

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
