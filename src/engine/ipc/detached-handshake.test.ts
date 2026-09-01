import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { IPC_SOCK_FILE } from '../../core/paths.js';
import { HEARTBEAT_STALENESS_MS } from '../../core/sessions/lockfile-status.js';
import { writeLockfile } from './lockfile.js';
import {
  acceptsDetachedPreparedResult,
  publishBootstrapLog,
  waitForServerReady,
} from './detached-handshake.js';
import { createSessionPreparationCandidate } from '../../core/sessions/prepare.js';

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
    sessionId: basename(testDir),
    mode: 'standard',
    feature: 'test feature',
    authToken: 'test-startup-auth',
    ...overrides,
  });
}

function sessionIdFor(dir: string): string {
  return basename(dir);
}

function detachedCandidate(projectDir: string, sessionId: string) {
  return createSessionPreparationCandidate({
    projectDir,
    feature: 'detached startup',
    persistTranscript: true,
    sessionId,
  });
}

beforeEach(() => {
  testDir = mkdtempSync('/tmp/sb-handshake-');
});

afterEach(async () => {
  await closeSocketServer();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('waitForServerReady', () => {
  it('returns { ok: true } when lockfile is alive and socket accepts connections', async () => {
    await writeServerLockfile();
    await listenOnSocket(join(testDir, IPC_SOCK_FILE));

    const result = await waitForServerReady({
      sessionDir: testDir,
      sessionId: sessionIdFor(testDir),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pid).toBe(process.pid);
      expect(result.sessionId).toBe(sessionIdFor(testDir));
    }
  });

  it('returns { ok: false } when lockfile never appears', async () => {
    const result = await waitForServerReady({
      sessionDir: testDir,
      sessionId: sessionIdFor(testDir),
      timeoutMs: 600,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('timeout');
    }
  });

  it('returns { ok: false } when lockfile heartbeat is stale', async () => {
    await writeServerLockfile({
      lastAliveMs: Date.now() - HEARTBEAT_STALENESS_MS - 1,
    });

    const result = await waitForServerReady({
      sessionDir: testDir,
      sessionId: sessionIdFor(testDir),
      timeoutMs: 600,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('timeout');
    }
  });

  it('fails fast with the recorded cause and log path when the server exits during startup', async () => {
    await writeServerLockfile({
      exitedAt: Date.now(),
      signal: 'uncaught',
      cause: 'config validation failed',
    });

    const start = Date.now();
    const result = await waitForServerReady({
      sessionDir: testDir,
      sessionId: sessionIdFor(testDir),
      timeoutMs: 5000,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(2000);
    if (!result.ok) {
      expect(result.reason).toContain('config validation failed');
      expect(result.reason).toContain(join(testDir, 'server.log'));
      expect(result.reason).not.toContain('timeout');
    }
  });

  it('falls back to the recorded signal when no cause is present on a startup exit', async () => {
    await writeServerLockfile({
      exitedAt: Date.now(),
      signal: 'SIGTERM',
    });

    const result = await waitForServerReady({
      sessionDir: testDir,
      sessionId: sessionIdFor(testDir),
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('SIGTERM');
    }
  });

  it('returns { ok: false } when the socket path exceeds the unix-domain byte limit', async () => {
    const longSessionDir = join(tmpdir(), 'd'.repeat(120));
    const candidate = join(longSessionDir, IPC_SOCK_FILE);
    expect(Buffer.byteLength(candidate, 'utf8')).toBeGreaterThan(104);

    const result = await waitForServerReady({
      sessionDir: longSessionDir,
      sessionId: sessionIdFor(longSessionDir),
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('unix-domain limit');
      expect(result.reason).toContain(candidate);
    }
  });
});

describe('publishBootstrapLog', () => {
  it('keeps the child log writable at its final session path after handoff cleanup', () => {
    const bootstrapDir = mkdtempSync(join(testDir, 'bootstrap-'));
    const finalDir = join(testDir, 'final-session');
    const bootstrapLog = join(bootstrapDir, 'server.log');
    mkdirSync(finalDir);
    const descriptor = openSync(bootstrapLog, 'a', 0o600);

    try {
      writeSync(descriptor, 'before handoff\n');
      const finalLog = publishBootstrapLog({ bootstrapDir, finalSessionDir: finalDir });
      rmSync(bootstrapDir, { recursive: true, force: true });
      writeSync(descriptor, 'after handoff\n');

      expect(finalLog).toBe(join(finalDir, 'server.log'));
      expect(readFileSync(finalLog, 'utf8')).toBe('before handoff\nafter handoff\n');
    } finally {
      closeSync(descriptor);
    }
  });
});

describe('acceptsDetachedPreparedResult', () => {
  it('accepts a response matching the candidate receipt and the spawned child pid', () => {
    const candidate = detachedCandidate(testDir, 'accepts-match');

    expect(
      acceptsDetachedPreparedResult({
        result: {
          version: 1,
          kind: 'prepared',
          sessionId: candidate.sessionId,
          ownership: candidate,
          active: candidate,
          pid: 4242,
        },
        candidate,
        childPid: 4242,
      }),
    ).toBe(true);
  });

  it('rejects a response reporting a pid other than the spawned child', () => {
    const candidate = detachedCandidate(testDir, 'rejects-pid');

    expect(
      acceptsDetachedPreparedResult({
        result: {
          version: 1,
          kind: 'prepared',
          sessionId: candidate.sessionId,
          ownership: candidate,
          active: candidate,
          pid: 4242,
        },
        candidate,
        childPid: 4243,
      }),
    ).toBe(false);
  });

  it('rejects a response whose ownership generation is not the candidate generation', () => {
    const candidate = detachedCandidate(testDir, 'rejects-generation');
    const stale = { ...candidate, generation: '12345678-1234-4123-8123-123456789abc' };

    expect(
      acceptsDetachedPreparedResult({
        result: {
          version: 1,
          kind: 'prepared',
          sessionId: candidate.sessionId,
          ownership: stale,
          active: candidate,
          pid: 4242,
        },
        candidate,
        childPid: 4242,
      }),
    ).toBe(false);
  });
});
