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

vi.mock('../../engine/ipc/crash-diagnostic.js', () => ({
  showCrashDiagnostic: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../app.js', () => ({
  App: () => null,
}));

vi.mock('../init-stores.js', () => ({
  initStores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../render.js', () => ({
  renderApp: vi.fn().mockResolvedValue(undefined),
}));

import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import { renderApp } from '../render.js';
import { routerStore } from '../../stores/navigation/router.js';
import { attachCommand } from './attach.js';

const mockCheckServerStatus = vi.mocked(checkServerStatus);
const mockRenderApp = vi.mocked(renderApp);

let testDir: string;
const originalPlatform = process.platform;
const originalStdoutIsTTY = process.stdout.isTTY;

beforeEach(() => {
  testDir = join(tmpdir(), `attach-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  vi.clearAllMocks();
  routerStore.reset();
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutIsTTY, configurable: true });
});

describe('attachCommand', () => {
  it('throws cliError with exit code 1 on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    await expect(
      attachCommand('some-session', { projectDir: testDir }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('not supported on Windows'),
    });
  });

  it('calls showCrashDiagnostic and throws when server status is not alive (crashed)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const sessDir = join(testDir, '.diptych', 'sessions', 'my-session');
    mkdirSync(sessDir, { recursive: true });

    const status = {
      alive: false as const,
      crashed: true,
      data: {
        version: 1 as const,
        pid: 12345,
        startTimeMs: 1000,
        lastAliveMs: 1000,
        sessionId: 'my-session',
        mode: 'standard',
        feature: 'test feature',
        signal: 'SIGTERM',
        cause: 'out of memory',
      },
    };
    mockCheckServerStatus.mockResolvedValue(status);

    await expect(
      attachCommand('my-session', { projectDir: testDir }),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it('renders the workflow app in attached-client mode when server is alive', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const sessDir = join(testDir, '.diptych', 'sessions', 'alive-session');
    mkdirSync(sessDir, { recursive: true });

    mockCheckServerStatus.mockResolvedValue({
      alive: true,
      data: {
        version: 1,
        pid: 99,
        startTimeMs: Date.now(),
        lastAliveMs: Date.now(),
        sessionId: 'alive-session',
        mode: 'quick',
        feature: 'do a thing',
      },
    });

    await expect(
      attachCommand('alive-session', { projectDir: testDir }),
    ).resolves.toBeUndefined();

    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      feature: 'do a thing',
      sessionId: 'alive-session',
      attach: {
        sockPath: join(sessDir, 'ipc.sock'),
      },
    });
    expect(mockRenderApp).toHaveBeenCalledWith(expect.anything(), {
      fullscreen: false,
      mouse: false,
    });
  });

  it('auto-resolves single running session when sessionId is undefined', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const sessDir = join(testDir, '.diptych', 'sessions', 'solo-session');
    mkdirSync(sessDir, { recursive: true });

    mockCheckServerStatus.mockResolvedValue({
      alive: true,
      data: {
        version: 1,
        pid: 88,
        startTimeMs: Date.now(),
        lastAliveMs: Date.now(),
        sessionId: 'solo-session',
        mode: 'instant',
        feature: 'solo feature',
      },
    });

    await expect(attachCommand(undefined, { projectDir: testDir })).resolves.toBeUndefined();

    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      feature: 'solo feature',
      sessionId: 'solo-session',
      attach: { sockPath: join(sessDir, 'ipc.sock') },
    });
  });
});
