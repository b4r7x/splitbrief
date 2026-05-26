import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { continueCommand, resolveSessionInput } from './continue.js';
import type { ContinueDeps } from './continue.js';
import { checkServerStatus } from '../../engine/ipc/lockfile.js';
import type { ServerStatus } from '../../engine/ipc/lockfile.js';
import { routerStore } from '../../stores/navigation/router.js';
import type { WorkflowOpts } from '../../core/types/config-options.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';

type RpcRun = {
  feature: string;
  projectDir: string;
  opts: WorkflowOpts;
  state: WorkflowState | undefined;
  sessionId: string | undefined;
};

type RenderRun = {
  route: ReturnType<typeof routerStore.get>;
  options: Parameters<ContinueDeps['renderApp']>[1];
};

let tmp: string;
let deps: ContinueDeps;
let rpcRuns: RpcRun[];
let renderRuns: RenderRun[];

function makeTmpProject(): string {
  tmp = createTempDir('continue-command-test');
  return tmp;
}

function makeSessionDir(projectDir: string, sessionId: string): string {
  const sessDir = join(projectDir, '.diptych', 'sessions', sessionId);
  mkdirSync(sessDir, { recursive: true });
  return sessDir;
}

function writeLockfile(sessDir: string, overrides: Record<string, unknown> = {}): void {
  const data = {
    version: 1,
    pid: process.pid,
    startTimeMs: Date.now(),
    lastAliveMs: Date.now(),
    sessionId: 'test-session',
    mode: 'standard',
    feature: 'test-feature',
    ...overrides,
  };
  writeFileSync(join(sessDir, 'lockfile.json'), JSON.stringify(data));
}

function writeState(sessDir: string, phase: string, extra: Record<string, unknown> = {}): void {
  const state = {
    stateVersion: 3,
    phase,
    feature: 'test-feature',
    currentTaskIndex: 0,
    attempt: 0,
    plannerSessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: {
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    },
    tasks: [
      {
        id: 'T001',
        title: 'task-1',
        action: 'create',
        file: 'src/test.ts',
        dependsOn: [],
        description: 'Test task',
        tests: [],
        constraints: [],
        typeDefs: '',
        implementationSteps: [],
        status: 'pending',
      },
    ],
    awaitingContinue: false,
    ...extra,
  };
  writeFileSync(join(sessDir, 'state.json'), JSON.stringify(state));
}

function createDeps(overrides: Partial<ContinueDeps> = {}): ContinueDeps {
  return {
    checkServerStatus,
    initStores: async () => {},
    renderApp: async (_app, options) => {
      renderRuns.push({ route: routerStore.get(), options });
    },
    runHeadless: async () => {},
    runRpc: async (feature, projectDir, opts, state, sessionId) => {
      rpcRuns.push({ feature, projectDir, opts, state, sessionId });
    },
    setupWorkflow: async (opts) => ({
      projectDir: opts.project ?? '',
      useFullscreen: false,
      useMouse: false,
    }),
    showCrashDiagnostic: async () => {},
    ...overrides,
  };
}

describe('continueCommand', () => {
  beforeEach(() => {
    resetAllStores();
    rpcRuns = [];
    renderRuns = [];
    deps = createDeps();
  });

  afterEach(() => {
    if (tmp) cleanupTempDir(tmp);
    tmp = '';
  });

  it('throws when no session exists and no active pointer', async () => {
    const projectDir = makeTmpProject();

    await expect(
      continueCommand(undefined, { projectDir }, deps),
    ).rejects.toThrow(/no session to continue/);
  });

  it('throws when explicit session ID has no state and is not running', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-my-feature');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-my-feature' });

    await expect(
      continueCommand('2025-04-01-my-feature', { projectDir }, deps),
    ).rejects.toThrow(/no saved state and is not running/);
  });

  it('throws for a completed session that is not resumable', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-done');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-done' });
    writeState(sessDir, 'complete');

    await expect(
      continueCommand('2025-04-01-done', { projectDir }, deps),
    ).rejects.toThrow(/cannot be resumed/);
  });

  it('routes interrupted sessions to RPC mode when --rpc is passed', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-rpc');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-rpc' });
    writeState(sessDir, 'implementing');

    await continueCommand('2025-04-01-rpc', { projectDir, rpc: true }, deps);

    expect(rpcRuns).toHaveLength(1);
    expect(rpcRuns[0]).toMatchObject({
      feature: 'test-feature',
      projectDir,
      opts: { rpc: true, projectDir },
      state: { feature: 'test-feature', phase: 'implementing' },
      sessionId: '2025-04-01-rpc',
    });
  });

  it('attaches the workflow screen when the target session is still running', async () => {
    const projectDir = makeTmpProject();
    deps = createDeps({
      checkServerStatus: async (): Promise<ServerStatus> => ({
        alive: true,
        data: {
          version: 1,
          pid: process.pid,
          startTimeMs: Date.now(),
          lastAliveMs: Date.now(),
          sessionId: '2025-04-01-live',
          mode: 'standard',
          feature: 'live feature',
        },
      }),
    });

    await continueCommand('2025-04-01-live', { projectDir }, deps);

    expect(renderRuns).toHaveLength(1);
    expect(renderRuns[0]?.route).toMatchObject({
      screen: 'workflow',
      feature: 'live feature',
      sessionId: '2025-04-01-live',
      attach: {
        sockPath: join(projectDir, '.diptych', 'sessions', '2025-04-01-live', 'ipc.sock'),
      },
    });
  });

  it('rejects --json and --rpc together', async () => {
    const projectDir = makeTmpProject();

    await expect(
      continueCommand(undefined, { projectDir, json: true, rpc: true }, deps),
    ).rejects.toThrow(/--json and --rpc cannot be combined/);
  });

  it('resolves explicit and missing session input', async () => {
    await expect(resolveSessionInput(undefined, '/tmp')).resolves.toBeUndefined();
    await expect(resolveSessionInput('2025-04-01-feat', '/tmp')).resolves.toBe('2025-04-01-feat');
  });

  it('rejects a session with an older stateVersion via loadState filtering', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-old');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-old' });
    writeState(sessDir, 'implementing', { stateVersion: 1 });

    await expect(
      continueCommand('2025-04-01-old', { projectDir }, deps),
    ).rejects.toThrow(/no saved state/);
  });

  it('accepts a session with the current stateVersion', async () => {
    const projectDir = makeTmpProject();
    const sessDir = makeSessionDir(projectDir, '2025-04-01-current');
    writeLockfile(sessDir, { exitedAt: Date.now(), sessionId: '2025-04-01-current' });
    writeState(sessDir, 'implementing');

    await continueCommand('2025-04-01-current', { projectDir }, deps);

    expect(renderRuns).toHaveLength(1);
  });
});
