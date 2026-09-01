import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { registerStartCommand } from './start/register.js';
import type { StartDeps } from './start/types.js';
import { initStores } from '../init-stores.js';
import { configStore } from '../../stores/project/config.js';
import { routerStore } from '../../stores/navigation/router.js';
import { SPLITBRIEF_DIR } from '../../core/paths.js';
import { sessionDir } from '../../core/paths.js';
import type { SpawnServerResult } from '../../engine/ipc/detached-handshake.js';
import { buildServerArgs, type SpawnServerOptions } from '../../engine/ipc/server-invocation.js';
import {
  prepareExecutionMock,
  setupRunnerTrustIsolation,
  writeReadyReadinessFixtures,
  writeConfigMarker,
} from '#testing/helpers/start-command.js';
import { writeEmptyDetectionCache } from '#testing/helpers/write-empty-detection-cache.js';
import { formatDetachedAttachHint } from './attach-hint.js';

setupFetchMock();

const spawnServerMock = vi.fn<(opts: SpawnServerOptions) => Promise<SpawnServerResult>>();
const runHeadlessMock = vi.fn<StartDeps['runHeadless']>();
const runRpcMock = vi.fn<StartDeps['runRpc']>();
const renderAppFake: StartDeps['renderApp'] = async () => {};

const fakeDeps: StartDeps = {
  spawnServer: spawnServerMock,
  runHeadless: runHeadlessMock as unknown as StartDeps['runHeadless'],
  runRpc: runRpcMock as unknown as StartDeps['runRpc'],
  initStores: async () => {},
  renderApp: renderAppFake,
  prepareExecution: prepareExecutionMock,
};

setupRunnerTrustIsolation();

let tmp = '';

beforeEach(() => {
  vi.mocked(globalThis.fetch).mockImplementation(async () => new Response('{}', { status: 200 }));
  tmp = realpathSync(createTempDir('start-command-unit-test'));
  createTestGitRepo(tmp);
  writeEmptyDetectionCache(tmp);
  resetAllStores();
  routerStore.init({ screen: 'home' });
  process.stdin.isTTY = true;
  spawnServerMock.mockClear();
  runHeadlessMock.mockClear();
  runRpcMock.mockClear();
  spawnServerMock.mockImplementation(async (opts: SpawnServerOptions) => {
    const preparedSessionDir = sessionDir(opts.projectDir, opts.candidate.sessionId);
    mkdirSync(preparedSessionDir, { recursive: true });
    writeFileSync(
      join(preparedSessionDir, 'server-args.json'),
      JSON.stringify(buildServerArgs(opts), null, 2),
    );
    return { ok: true, pid: 1234, sessionId: opts.candidate.sessionId };
  });
  runHeadlessMock.mockResolvedValue(undefined);
  runRpcMock.mockResolvedValue(undefined);
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  delete (process.stdin as { isTTY?: boolean }).isTTY;
});

describe('start command — shorthand invocation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('direct interactive start uses the shared preparation policy', async () => {
    writeConfigMarker(tmp);

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    await program.parseAsync(['node', 'splitbrief', 'implement auth flow', '--project', tmp]);

    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      execution: {
        kind: 'local',
        prepared: {
          purpose: 'new-workflow',
          runtime: { feature: 'implement auth flow' },
        },
      },
    });
  });

  it('applies --mode quick through real store initialization on shorthand invocation', async () => {
    writeConfigMarker(tmp);

    const deps: StartDeps = {
      ...fakeDeps,
      initStores,
      renderApp: async () => {},
    };

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, deps);
    await program.parseAsync([
      'node',
      'splitbrief',
      '--mode',
      'quick',
      'build feature X',
      '--project',
      tmp,
    ]);

    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      execution: {
        kind: 'local',
        prepared: { runtime: { feature: 'build feature X' } },
      },
    });
    expect(configStore.get().config?.workflow.mode).toBe('quick');
  }, 30_000);

  it('interactive JSON and RPC starts consume prepared execution', async () => {
    const projects = ['interactive', 'json', 'rpc'].map((mode) => {
      const projectDir = realpathSync(createTempDir(`start-prepared-${mode}`));
      createTestGitRepo(projectDir);
      writeConfigMarker(projectDir);
      writeEmptyDetectionCache(projectDir);
      return projectDir;
    }) as [string, string, string];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      for (const [mode, projectDir] of [
        ['interactive', projects[0]],
        ['json', projects[1]],
        ['rpc', projects[2]],
      ] as const) {
        const program = new Command();
        program.exitOverride();
        registerStartCommand(program, fakeDeps);
        await program.parseAsync([
          'node',
          'splitbrief',
          '--project',
          projectDir,
          ...(mode === 'interactive' ? [] : [`--${mode}`]),
          `${mode} prepared feature`,
        ]);
      }

      expect(routerStore.get()).toMatchObject({
        execution: {
          kind: 'local',
          prepared: {
            purpose: 'new-workflow',
            runtime: { feature: 'interactive prepared feature' },
          },
        },
      });
      expect(runHeadlessMock.mock.calls.at(-1)?.[0]).toMatchObject({
        prepared: { purpose: 'new-workflow', runtime: { feature: 'json prepared feature' } },
      });
      expect(runRpcMock.mock.calls.at(-1)?.[0]).toMatchObject({
        prepared: { purpose: 'new-workflow', runtime: { feature: 'rpc prepared feature' } },
      });
    } finally {
      stdout.mockRestore();
      for (const projectDir of projects) cleanupTempDir(projectDir);
    }
  }, 30_000);

  it('JSON start uses the shared headless preparation policy', async () => {
    writeConfigMarker(tmp);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const program = new Command();
      program.exitOverride();
      registerStartCommand(program, fakeDeps);
      await program.parseAsync([
        'node',
        'splitbrief',
        '--project',
        tmp,
        '--json',
        'headless prepared feature',
      ]);
    } finally {
      stdout.mockRestore();
    }

    expect(runHeadlessMock).toHaveBeenCalledOnce();
    expect(runHeadlessMock.mock.calls[0]?.[0]).toMatchObject({
      prepared: {
        purpose: 'new-workflow',
        runtime: { feature: 'headless prepared feature' },
      },
    });
  }, 30_000);
});

describe('start command — detached', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the full shell-safe attach Run line for project paths with spaces', async () => {
    const spaced = join(tmp, 'my project');
    mkdirSync(spaced, { recursive: true });
    createTestGitRepo(spaced);
    writeReadyReadinessFixtures(spaced);
    writeEmptyDetectionCache(spaced);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    await program.parseAsync([
      'node',
      'splitbrief',
      '--project',
      spaced,
      '--detach',
      'implement X',
    ]);

    const sessionIds = readdirSync(join(spaced, SPLITBRIEF_DIR, 'sessions'));
    expect(sessionIds).toHaveLength(1);
    const sessionId = sessionIds[0] ?? '';

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => call.join(' '))
      .join('\n');
    const expectedRun = `Run: ${formatDetachedAttachHint(spaced, sessionId)}`;
    expect(output).toContain(expectedRun);
    expect(output).not.toContain('cd ');
  }, 30_000);
});
