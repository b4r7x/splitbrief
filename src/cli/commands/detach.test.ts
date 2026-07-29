import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server, type Socket } from 'node:net';
import { detachCommand, type DetachDeps } from './detach.js';
import type { ServerStatus } from '../../engine/ipc/lockfile.js';

let testDir: string;
let server: Server | null = null;
const originalPlatform = process.platform;
const received: string[] = [];

function runningStatus(sessionId: string): ServerStatus {
  return {
    alive: true,
    data: {
      version: 1,
      pid: 99,
      startTimeMs: Date.now(),
      lastAliveMs: Date.now(),
      sessionId,
      mode: 'quick',
      feature: 'do a thing',
      authToken: 'test-auth-token',
    },
  };
}

function writeLockfile(sessionId: string, startTimeMs: number): void {
  const sessDir = join(testDir, '.splitbrief', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(
    join(sessDir, 'lockfile.json'),
    JSON.stringify({
      version: 1,
      pid: 99,
      startTimeMs,
      lastAliveMs: startTimeMs + 1000,
      sessionId,
      mode: 'quick',
      feature: 'do a thing',
    }),
  );
}

function createDeps(status: ServerStatus): DetachDeps {
  return {
    checkServerStatus: async () => status,
  };
}

function listen(sockPath: string): Promise<void> {
  server = createServer((socket: Socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) received.push(line.trim());
      }
      socket.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(sockPath, resolve);
  });
}

function listenSplitError(sockPath: string, message: string): Promise<void> {
  server = createServer((socket: Socket) => {
    socket.once('data', () => {
      const frame = Buffer.from(
        `${JSON.stringify({ kind: 'error', code: 'unauthorized', message })}\n`,
        'utf8',
      );
      // Split inside the first multibyte character of the message body.
      const at = frame.indexOf(Buffer.from(message, 'utf8')[0]!) + 1;
      socket.write(frame.subarray(0, at));
      setTimeout(() => socket.write(frame.subarray(at)), 10);
    });
  });

  return new Promise((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(sockPath, resolve);
  });
}

function closeServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server = null;
  });
}

beforeEach(() => {
  testDir = join(tmpdir(), `dt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  received.length = 0;
});

afterEach(async () => {
  await closeServer().catch(() => undefined);
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe('detachCommand', () => {
  it('throws cliError with exit code 1 on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    await expect(
      detachCommand(
        'some-session',
        { projectDir: testDir },
        createDeps(runningStatus('some-session')),
      ),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('not supported on Windows'),
    });
  });

  it('sends detach to a running session socket', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const sessDir = join(testDir, '.splitbrief', 'sessions', 'alive-session');
    mkdirSync(sessDir, { recursive: true });
    await listen(join(sessDir, 'ipc.sock'));

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => {
      logs.push(line);
    });

    await expect(
      detachCommand(
        'alive-session',
        { projectDir: testDir },
        createDeps(runningStatus('alive-session')),
      ),
    ).resolves.toBeUndefined();

    expect(received.map((line) => JSON.parse(line))).toEqual([
      { kind: 'authenticate', token: 'test-auth-token' },
      { kind: 'detach' },
    ]);
    expect(logs).toContain('Session alive-session detached.');
  });

  it('resolves numeric aliases before detaching', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    writeLockfile('older-session', 1000);
    writeLockfile('newer-session', 2000);
    const sessDir = join(testDir, '.splitbrief', 'sessions', 'newer-session');
    await listen(join(sessDir, 'ipc.sock'));

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => {
      logs.push(line);
    });

    await expect(
      detachCommand('1', { projectDir: testDir }, createDeps(runningStatus('newer-session'))),
    ).resolves.toBeUndefined();

    expect(received.map((line) => JSON.parse(line))).toEqual([
      { kind: 'authenticate', token: 'test-auth-token' },
      { kind: 'detach' },
    ]);
    expect(logs).toContain('Session newer-session detached.');
  });

  it('reassembles a multibyte server error message split across socket frames', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const sessDir = join(testDir, '.splitbrief', 'sessions', 'alive-session');
    mkdirSync(sessDir, { recursive: true });
    const message = 'セッションはすでに接続されています';
    await listenSplitError(join(sessDir, 'ipc.sock'), message);

    await expect(
      detachCommand(
        'alive-session',
        { projectDir: testDir },
        createDeps(runningStatus('alive-session')),
      ),
    ).rejects.toMatchObject({ message });
  });

  it('fails when a running session has no auth token', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const status = runningStatus('legacy-session');
    if (!status.alive) throw new Error('expected alive status');
    delete status.data.authToken;

    await expect(
      detachCommand('legacy-session', { projectDir: testDir }, createDeps(status)),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: 'session legacy-session does not support authenticated detach',
    });
  });

  it('fails when the session is not running', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    await expect(
      detachCommand(
        'dead-session',
        {
          projectDir: testDir,
        },
        createDeps({ alive: false, crashed: false, data: null }),
      ),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: 'session dead-session is not running',
    });
  });
});
