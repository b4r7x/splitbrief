import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { routerStore } from '../../stores/navigation/router.js';
import { attachCommand } from './attach.js';
import type { AttachDeps } from './attach.js';
import type { ServerStatus } from '../../engine/ipc/lockfile.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import type { StateAuthorityReceipt } from '../../core/state/types.js';

const mockCheckServerStatus = vi.fn<(dir: string) => Promise<ServerStatus>>();
const mockInitObserverStores = vi.fn<(projectDir: string) => void>();
const mockReadStateAuthority = vi.fn<(ref: SessionRef) => StateAuthorityReceipt | null>((ref) => ({
  kind: 'usable',
  sessionId: ref.sessionId,
  ownerId: 'owner-1',
  pid: process.pid,
  processStart: '1',
  runId: 'run-1',
  acquisitionId: 'acquisition-1',
  fence: 1,
  stateRevision: 1,
  stateDigest: 'a'.repeat(64),
}));
const mockAssertStateAuthority = vi.fn();
const renderCalls: Array<Parameters<AttachDeps['renderApp']>[1]> = [];
const mockRenderAppWithCapture: AttachDeps['renderApp'] = async (_app, options) => {
  renderCalls.push(options);
};
const fakeDeps: AttachDeps = {
  checkServerStatus: mockCheckServerStatus,
  initObserverStores: mockInitObserverStores,
  renderApp: mockRenderAppWithCapture,
  readStateAuthority: mockReadStateAuthority,
  assertStateAuthority: mockAssertStateAuthority,
};

let testDir: string;
const originalPlatform = process.platform;
const originalStdoutIsTTY = process.stdout.isTTY;

beforeEach(() => {
  testDir = join(tmpdir(), `attach-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  vi.clearAllMocks();
  mockAssertStateAuthority.mockReset();
  mockReadStateAuthority.mockImplementation((ref) => ({
    kind: 'usable',
    sessionId: ref.sessionId,
    ownerId: 'owner-1',
    pid: process.pid,
    processStart: '1',
    runId: 'run-1',
    acquisitionId: 'acquisition-1',
    fence: 1,
    stateRevision: 1,
    stateDigest: 'a'.repeat(64),
  }));
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

  it('refuses a dead session without a local fallback or crash-side effect', async () => {
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
    mockReadStateAuthority.mockReturnValue({
      kind: 'usable',
      sessionId: 'another-session',
      ownerId: 'owner-1',
      pid: process.pid,
      processStart: '1',
      runId: 'run-1',
      acquisitionId: 'acquisition-1',
      fence: 1,
      stateRevision: 1,
      stateDigest: 'a'.repeat(64),
    });

    await expect(
      attachCommand('dead-session', { projectDir: testDir }, fakeDeps),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('no matching live owner authority'),
    });
    expect(mockInitObserverStores).not.toHaveBeenCalled();
    expect(renderCalls).toHaveLength(0);
  });

  it('attached entry bypasses local preparation and runner factories', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const sessDir = join(testDir, '.splitbrief', 'sessions', 'alive-session');
    mkdirSync(sessDir, { recursive: true });

    mockCheckServerStatus.mockResolvedValue({
      alive: true,
      data: {
        version: 1,
        pid: process.pid,
        startTimeMs: 1,
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
      fullscreen: false,
      mouse: false,
      hover: false,
    });
    expect(mockReadStateAuthority).toHaveBeenCalledWith({
      projectDir: testDir,
      sessionId: 'alive-session',
    });
    expect(mockAssertStateAuthority).toHaveBeenCalledWith({
      ref: { projectDir: testDir, sessionId: 'alive-session' },
      receipt: expect.objectContaining({ sessionId: 'alive-session' }),
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
        pid: process.pid,
        startTimeMs: 1,
        lastAliveMs: Date.now(),
        sessionId: 'solo-session',
        mode: 'quick',
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

  it('uses authority identity instead of heartbeat freshness for a live owner', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const sessDir = join(testDir, '.splitbrief', 'sessions', 'stale-heartbeat');
    mkdirSync(sessDir, { recursive: true });
    mockCheckServerStatus.mockResolvedValue({
      alive: false,
      crashed: true,
      processAlive: true,
      data: {
        version: 1,
        pid: process.pid,
        startTimeMs: 1,
        lastAliveMs: 1,
        sessionId: 'stale-heartbeat',
        mode: 'quick',
        feature: 'owner feature',
        authToken: 'test-auth-token',
      },
    });

    await expect(
      attachCommand('stale-heartbeat', { projectDir: testDir }, fakeDeps),
    ).resolves.toBeUndefined();
    expect(renderCalls).toHaveLength(1);
  });

  it('refuses a running session without a matching authority before initialization or render', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const sessDir = join(testDir, '.splitbrief', 'sessions', 'missing-authority');
    mkdirSync(sessDir, { recursive: true });
    mockCheckServerStatus.mockResolvedValue({
      alive: true,
      data: {
        version: 1,
        pid: 99,
        startTimeMs: Date.now(),
        lastAliveMs: Date.now(),
        sessionId: 'missing-authority',
        mode: 'quick',
        feature: 'observe only',
        authToken: 'test-auth-token',
      },
    });
    mockReadStateAuthority.mockReturnValue(null);

    await expect(
      attachCommand('missing-authority', { projectDir: testDir }, fakeDeps),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('no matching live owner authority'),
    });
    expect(mockInitObserverStores).not.toHaveBeenCalled();
    expect(renderCalls).toHaveLength(0);
  });

  it('refuses a dead or mismatched owner without falling back locally', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const sessDir = join(testDir, '.splitbrief', 'sessions', 'dead-authority');
    mkdirSync(sessDir, { recursive: true });
    mockCheckServerStatus.mockResolvedValue({
      alive: true,
      data: {
        version: 1,
        pid: 99,
        startTimeMs: Date.now(),
        lastAliveMs: Date.now(),
        sessionId: 'dead-authority',
        mode: 'quick',
        feature: 'observe only',
        authToken: 'test-auth-token',
      },
    });
    mockAssertStateAuthority.mockImplementation(() => {
      throw new Error('owner process is dead');
    });

    await expect(
      attachCommand('dead-authority', { projectDir: testDir }, fakeDeps),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('owner authority is dead or mismatched'),
    });
    expect(mockInitObserverStores).not.toHaveBeenCalled();
    expect(renderCalls).toHaveLength(0);
  });
});
