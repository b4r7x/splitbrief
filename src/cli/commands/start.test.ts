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
import { DIPTYCH_DIR } from '../../core/paths.js';
import type { SpawnServerOptions, SpawnServerResult } from '../../engine/ipc/spawn-server.js';
import { buildServerArgs } from '../../engine/ipc/spawn-server.js';
import { writeReadyReadinessFixtures, writeConfigMarker } from '#testing/helpers/start-command.js';
import { writeEmptyDetectionCache } from '#testing/helpers/write-empty-detection-cache.js';
import { formatDetachedAttachHint } from './attach-hint.js';

setupFetchMock();

const spawnServerMock = vi.fn<(opts: SpawnServerOptions) => Promise<SpawnServerResult>>();
const runHeadlessMock = vi.fn<() => Promise<void>>();
const runRpcMock = vi.fn<() => Promise<void>>();
const renderAppFake: StartDeps['renderApp'] = async () => {};

const fakeDeps: StartDeps = {
  spawnServer: spawnServerMock,
  runHeadless: runHeadlessMock as unknown as StartDeps['runHeadless'],
  runRpc: runRpcMock as unknown as StartDeps['runRpc'],
  initStores: async () => {},
  renderApp: renderAppFake,
};

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
    mkdirSync(opts.sessionDir, { recursive: true });
    writeFileSync(
      join(opts.sessionDir, 'server-args.json'),
      JSON.stringify(buildServerArgs(opts), null, 2),
    );
    return { ok: true, pid: 1234, sessionId: opts.sessionId };
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

  it('routes bare positional feature to start action via default command', async () => {
    writeConfigMarker(tmp);

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    await program.parseAsync(['node', 'diptych', 'implement auth flow', '--project', tmp]);

    expect(routerStore.get()).toMatchObject({ screen: 'workflow', feature: 'implement auth flow' });
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
      'diptych',
      '--mode',
      'quick',
      'build feature X',
      '--project',
      tmp,
    ]);

    expect(routerStore.get()).toMatchObject({ screen: 'workflow', feature: 'build feature X' });
    expect(configStore.get().config?.workflow.mode).toBe('quick');
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
    await program.parseAsync(['node', 'diptych', '--project', spaced, '--detach', 'implement X']);

    const sessionIds = readdirSync(join(spaced, DIPTYCH_DIR, 'sessions'));
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
