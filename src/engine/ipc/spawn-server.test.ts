import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { IPC_SOCK_FILE } from '../../core/paths.js';
import { HEARTBEAT_STALENESS_MS } from './constants.js';
import { writeLockfile } from './lockfile.js';
import { waitForServerReady } from './spawn-server.js';
import {
  parseIpcServerArgs,
  readIpcServerArgsFile,
  writeIpcServerArgsFile,
} from './server-args.js';

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
    if (!socketServer) {
      resolve();
      return;
    }
    socketServer.close(() => resolve());
    socketServer = null;
  });
}

function currentProcessStartTimeMs(): number {
  const raw = execSync(`ps -o lstart= -p ${process.pid}`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

async function writeServerLockfile(
  overrides?: Partial<Parameters<typeof writeLockfile>[1]>,
): Promise<void> {
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

describe('server args launch contract', () => {
  it('stores detached launch details in a secure args file', () => {
    const argsFile = writeIpcServerArgsFile(testDir, {
      sessionId: 'test-session',
      projectDir: '/repo',
      feature: 'implement from @file\n\nsecret context',
      mode: 'standard',
      configPath: '/repo/.diptych/config.yaml',
      overrides: { budget: 4 },
    });

    expect(statSync(argsFile).mode & 0o777).toBe(0o600);
    expect(readIpcServerArgsFile(argsFile)).toMatchObject({
      sessionId: 'test-session',
      feature: 'implement from @file\n\nsecret context',
      overrides: { budget: 4 },
    });

    const argv = ['server-entry.js', argsFile];
    expect(argv.join('\n')).not.toContain('implement from @file');
    expect(argv.join('\n')).not.toContain('secret context');
    expect(argv).toEqual(['server-entry.js', argsFile]);
  });

  it('rejects server args with incorrectly typed nested overrides', () => {
    const parsed = parseIpcServerArgs({
      sessionId: 'test-session',
      projectDir: '/repo',
      feature: 'feature',
      mode: 'standard',
      configPath: '/repo/.diptych/config.yaml',
      overrides: { yolo: 'yes' },
    });

    expect(parsed).toBeNull();
  });

  it('strips unknown nested override keys and keeps known fields', () => {
    const parsed = parseIpcServerArgs({
      sessionId: 'test-session',
      projectDir: '/repo',
      feature: 'feature',
      mode: 'standard',
      configPath: '/repo/.diptych/config.yaml',
      overrides: { planner: { tool: 'codex', extra: true } },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.overrides).toEqual({ planner: { tool: 'codex' } });
  });

  it('normalizes the legacy full mode to speckit', () => {
    const parsed = parseIpcServerArgs({
      sessionId: 'test-session',
      projectDir: '/repo',
      feature: 'feature',
      mode: 'full',
      configPath: '/repo/.diptych/config.yaml',
      overrides: {},
    });

    expect(parsed?.mode).toBe('speckit');
  });

  it('normalizes the legacy full mode inside nested overrides to speckit', () => {
    const parsed = parseIpcServerArgs({
      sessionId: 'test-session',
      projectDir: '/repo',
      feature: 'feature',
      mode: 'full',
      configPath: '/repo/.diptych/config.yaml',
      overrides: { mode: 'full' },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe('speckit');
    expect(parsed?.overrides.mode).toBe('speckit');
  });
});
