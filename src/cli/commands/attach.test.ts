import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { routerStore } from '../../stores/navigation/router.js';
import { attachCommand } from './attach.js';
import type { AttachDeps } from './attach.js';
import { showCrashDiagnostic } from '../crash-diagnostic.js';
import type { ServerStatus } from '../../engine/ipc/lockfile.js';

const mockCheckServerStatus = vi.fn<(dir: string) => Promise<ServerStatus>>();
const mockShowCrashDiagnostic = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockInitStores = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const renderCalls: Array<Parameters<AttachDeps['renderApp']>[1]> = [];
const mockRenderAppWithCapture: AttachDeps['renderApp'] = async (_app, options) => {
  renderCalls.push(options);
};
const FIXED_SETUP_RESULT = {
  projectDir: '',
  useFullscreen: true,
  useMouse: true,
  useHover: false,
} as const;

const mockSetupWorkflow: AttachDeps['setupWorkflow'] = async (opts) => ({
  ...FIXED_SETUP_RESULT,
  projectDir: opts.project ?? testDir,
});

const fakeDeps: AttachDeps = {
  checkServerStatus: mockCheckServerStatus,
  showCrashDiagnostic: mockShowCrashDiagnostic,
  initStores: mockInitStores,
  renderApp: mockRenderAppWithCapture,
  setupWorkflow: mockSetupWorkflow,
};

let testDir: string;
const originalPlatform = process.platform;
const originalStdoutIsTTY = process.stdout.isTTY;

beforeEach(() => {
  testDir = join(tmpdir(), `attach-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  vi.clearAllMocks();
  renderCalls.length = 0;
  routerStore.reset();
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalStdoutIsTTY,
    configurable: true,
  });
});

describe('attachCommand', () => {
  it('throws cliError with exit code 1 on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    await expect(
      attachCommand('some-session', { projectDir: testDir }, fakeDeps),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('not supported on Windows'),
    });
  });

  it('throws a curated not-found error for an explicit session id with no session dir', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    await expect(
      attachCommand('typo-session', { projectDir: testDir }, fakeDeps),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("session 'typo-session' not found"),
    });
    expect(mockCheckServerStatus).not.toHaveBeenCalled();
  });

  it('throws exit-1 for a dead session using the real crash diagnostic without exiting the process', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const sessDir = join(testDir, '.splitbrief', 'sessions', 'dead-session');
    mkdirSync(sessDir, { recursive: true });

    const status: ServerStatus = {
      alive: false,
      crashed: true,
      data: {
        version: 1,
        pid: 4242,
        startTimeMs: 1000,
        lastAliveMs: 1000,
        sessionId: 'dead-session',
        mode: 'standard',
        feature: 'test feature',
        signal: 'SIGKILL',
        cause: 'out of memory',
      },
    };
    mockCheckServerStatus.mockResolvedValue(status);

    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data: unknown) => {
      written.push(String(data));
      return true;
    };
    let exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    process.exit = ((code?: number) => {
      exitCode = code;
    }) as typeof process.exit;

    try {
      await expect(
        attachCommand(
          'dead-session',
          { projectDir: testDir },
          {
            ...fakeDeps,
            showCrashDiagnostic: (dir, st) => showCrashDiagnostic(dir, st, async () => '2'),
          },
        ),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(written.join('')).toContain('CRASHED');
      expect(exitCode).toBeUndefined();
    } finally {
      process.stdout.write = origWrite;
      process.exit = origExit;
    }
  });

  it('attached entry bypasses local preparation and runner factories', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const sessDir = join(testDir, '.splitbrief', 'sessions', 'alive-session');
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
        authToken: 'test-auth-token',
      },
    });

    await expect(
      attachCommand('alive-session', { projectDir: testDir }, fakeDeps),
    ).resolves.toBeUndefined();

    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      execution: {
        kind: 'attached',
        feature: 'do a thing',
        sessionId: 'alive-session',
        attach: {
          sockPath: join(sessDir, 'ipc.sock'),
          authToken: 'test-auth-token',
        },
      },
    });
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]).toEqual({
      fullscreen: true,
      mouse: true,
      hover: false,
    });
  });

  it('auto-resolves single running session when sessionId is undefined', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const sessDir = join(testDir, '.splitbrief', 'sessions', 'solo-session');
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
        authToken: 'test-auth-token',
      },
    });

    await expect(
      attachCommand(undefined, { projectDir: testDir }, fakeDeps),
    ).resolves.toBeUndefined();

    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      execution: {
        kind: 'attached',
        feature: 'solo feature',
        sessionId: 'solo-session',
        attach: {
          sockPath: join(sessDir, 'ipc.sock'),
          authToken: 'test-auth-token',
        },
      },
    });
  });
});
