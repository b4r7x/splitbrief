import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { IPC_SOCK_FILE } from '../../core/paths.js';
import { HEARTBEAT_STALENESS_MS } from './constants.js';
import { writeLockfile } from './lockfile.js';
import { waitForServerReady } from './spawn-server.js';

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
});

afterEach(async () => {
  await closeSocketServer();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('waitForServerReady', () => {
  it('returns { ok: true } when lockfile is alive and socket accepts connections', async () => {
    await writeServerLockfile();
    await listenOnSocket(join(testDir, IPC_SOCK_FILE));

    const result = await waitForServerReady(testDir, 'test-session');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(process.pid);
      expect(result.sessionId).toBe('test-session');
    }
  });

  it('returns { ok: false } when lockfile never appears', async () => {
    const result = await waitForServerReady(testDir, 'test-session', 600);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('timeout');
    }
  });

  it('returns { ok: false } when lockfile heartbeat is stale', async () => {
    await writeServerLockfile({
      lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1,
    });

    const result = await waitForServerReady(testDir, 'test-session', 600);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('timeout');
    }
  });
});
