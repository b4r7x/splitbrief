import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { setupFetchMock } from '#testing/helpers/fetch-mock.js';
import { registerStartCommand } from './start/register.js';
import type { StartDeps } from './start/types.js';
import { initStores } from '../init-stores.js';
import { configStore } from '../../stores/project/config.js';
import { routerStore } from '../../stores/navigation/router.js';
import {
  prepareExecutionMock,
  setupRunnerTrustIsolation,
  writeConfigMarker,
} from '#testing/helpers/start-command.js';
import { writeEmptyDetectionCache } from '#testing/helpers/write-empty-detection-cache.js';

setupFetchMock();

const runHeadlessMock = vi.fn<StartDeps['runHeadless']>();
const renderAppFake: StartDeps['renderApp'] = async () => {};

const fakeDeps: StartDeps = {
  runHeadless: runHeadlessMock as unknown as StartDeps['runHeadless'],
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
  runHeadlessMock.mockClear();
  runHeadlessMock.mockResolvedValue(undefined);
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

  it('interactive and JSON starts consume prepared execution', async () => {
    const projects = ['interactive', 'json'].map((mode) => {
      const projectDir = realpathSync(createTempDir(`start-prepared-${mode}`));
      createTestGitRepo(projectDir);
      writeConfigMarker(projectDir);
      writeEmptyDetectionCache(projectDir);
      return projectDir;
    }) as [string, string];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      for (const [mode, projectDir] of [
        ['interactive', projects[0]],
        ['json', projects[1]],
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
