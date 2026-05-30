import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import type { ServerStatus } from './lockfile.js';
import { buildCrashDiagnostic } from './crash-diagnostic.js';

const BASE_STATUS_CRASHED: ServerStatus = {
  alive: false,
  crashed: true,
  data: {
    version: 1,
    pid: 12345,
    startTimeMs: 1745668330000,
    lastAliveMs: 1745669242000,
    sessionId: 'abc123',
    mode: 'standard',
    feature: 'test feature',
    signal: 'SIGKILL',
    cause: 'OOM',
  },
};

const BASE_STATUS_EXITED: ServerStatus = {
  alive: false,
  crashed: false,
  data: {
    version: 1,
    pid: 99999,
    startTimeMs: 1745668330000,
    lastAliveMs: 1745669242000,
    sessionId: 'xyz789',
    mode: 'quick',
    feature: 'done feature',
    exitedAt: 1745669300000,
    exitCode: 0,
  },
};

const NULL_STATUS: ServerStatus = {
  alive: false,
  crashed: false,
  data: null,
};

describe('buildCrashDiagnostic', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `crash-diag-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null-filled fields when status.data is null', async () => {
    const diag = await buildCrashDiagnostic(tmpDir, NULL_STATUS);
    expect(diag.pid).toBeNull();
    expect(diag.startedAt).toBeNull();
    expect(diag.lastAliveAt).toBeNull();
    expect(diag.exitedAt).toBeNull();
    expect(diag.signal).toBeNull();
    expect(diag.exitCode).toBeNull();
    expect(diag.cause).toBeNull();
    expect(diag.status).toBe('exited');
  });

  it('extracts correct fields from valid LockfileData (crashed)', async () => {
    const diag = await buildCrashDiagnostic(tmpDir, BASE_STATUS_CRASHED);
    expect(diag.sessionId).toBe('abc123');
    expect(diag.pid).toBe(12345);
    expect(diag.startedAt).toBe(1745668330000);
    expect(diag.lastAliveAt).toBe(1745669242000);
    expect(diag.signal).toBe('SIGKILL');
    expect(diag.cause).toBe('OOM');
    expect(diag.status).toBe('crashed');
    expect(diag.exitCode).toBeNull();
  });

  it('extracts correct fields from valid LockfileData (exited)', async () => {
    const diag = await buildCrashDiagnostic(tmpDir, BASE_STATUS_EXITED);
    expect(diag.sessionId).toBe('xyz789');
    expect(diag.exitCode).toBe(0);
    expect(diag.exitedAt).toBe(1745669300000);
    expect(diag.status).toBe('exited');
  });

  it('reads logTail when server.log exists', async () => {
    const logContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeFile(join(tmpDir, 'server.log'), logContent);
    const diag = await buildCrashDiagnostic(tmpDir, BASE_STATUS_CRASHED);
    expect(diag.logTail).not.toBeNull();
    expect(diag.logTail).toContain('line 30');
    // Should only have last 20 lines
    expect(diag.logTail).not.toContain('line 1\n');
    expect(diag.logTail).toContain('line 11');
  });

  it('sets logTail=null when server.log is missing', async () => {
    const diag = await buildCrashDiagnostic(tmpDir, BASE_STATUS_CRASHED);
    expect(diag.logTail).toBeNull();
  });
});
