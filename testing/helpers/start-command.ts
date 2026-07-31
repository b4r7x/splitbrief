import { beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeSessionLockfile } from '#testing/helpers/factories/session-lockfile.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { registerStartCommand } from '../../src/cli/commands/start/register.js';
import type { StartDeps } from '../../src/cli/commands/start/types.js';
import { CONFIG_FILE, SPLITBRIEF_DIR, LOCKFILE, STATE_FILE } from '../../src/core/paths.js';
import type { SpawnServerOptions, SpawnServerResult } from '../../src/engine/ipc/spawn-server.js';
import { buildServerArgs } from '../../src/engine/ipc/spawn-server.js';
import { routerStore } from '../../src/stores/navigation/router.js';

export const spawnServerMock = vi.fn<(opts: SpawnServerOptions) => Promise<SpawnServerResult>>();
export const runHeadlessMock = vi.fn<() => Promise<void>>();
export const runRpcMock = vi.fn<() => Promise<void>>();

const initStoresMock: StartDeps['initStores'] = async () => {};
export const renderCalls: Array<Parameters<StartDeps['renderApp']>[1]> = [];

const renderAppFake: StartDeps['renderApp'] = async (_app, options) => {
  renderCalls.push(options);
};

export const fakeDeps: StartDeps = {
  spawnServer: spawnServerMock,
  runHeadless: runHeadlessMock as unknown as StartDeps['runHeadless'],
  runRpc: runRpcMock as unknown as StartDeps['runRpc'],
  initStores: initStoresMock,
  renderApp: renderAppFake,
};

let tmp = '';

export function getStartCommandTmp(): string {
  return tmp;
}

export function setupStartCommandIntegration(): void {
  beforeEach(() => {
    tmp = realpathSync(createTempDir('start-command-test'));
    createTestGitRepo(tmp);
    resetAllStores();
    routerStore.init({ screen: 'home' });
    process.stdin.isTTY = true;
    renderCalls.length = 0;
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
}

export async function runStart(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStartCommand(program, fakeDeps);
  await program.parseAsync(['node', 'splitbrief', 'start', ...args]);
}

export function writeLiveSession(projectDir: string, sessionId: string): void {
  const sDir = join(projectDir, SPLITBRIEF_DIR, 'sessions', sessionId);
  mkdirSync(sDir, { recursive: true });
  writeFileSync(
    join(sDir, STATE_FILE),
    JSON.stringify({ feature: 'test', phase: 'implementing', tasks: [], currentTaskIndex: 0 }),
  );
  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(join(projectDir, SPLITBRIEF_DIR, 'active'), sessionId + '\n');
}

export function writeSessionLockfile(
  projectDir: string,
  sessionId: string,
  overrides: Parameters<typeof makeSessionLockfile>[1] = {},
): void {
  const sDir = join(projectDir, SPLITBRIEF_DIR, 'sessions', sessionId);
  mkdirSync(sDir, { recursive: true });
  writeFileSync(
    join(sDir, LOCKFILE),
    JSON.stringify(
      makeSessionLockfile(sessionId, {
        feature: 'test',
        ...overrides,
      }),
    ),
  );
}

export function writeConfigMarker(projectDir: string): void {
  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(
    join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE),
    [
      'version: 3',
      'planner:',
      '  kind: shell',
      "  command: 'true'",
      '  outputFormat: text',
      '  model: shell',
      '  contextLength: 32768',
      'implementer:',
      '  kind: api',
      '  provider: ollama',
      '  apiBase: http://localhost:11434/v1',
      '  model: qwen2.5-coder:7b',
      '  contextLength: 32768',
      'validation:',
      '  typecheck: true',
      '  lint: true',
      '  test: true',
      '  typecheckCommand: node -e ""',
      '  lintCommand: node -e ""',
      '  testCommand: node -e ""',
    ].join('\n'),
    'utf-8',
  );
}

export function writeReadyReadinessFixtures(
  projectDir: string,
  options: { validation?: boolean; codebase?: boolean; persistTranscript?: boolean } = {},
): void {
  mkdirSync(join(projectDir, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.splitbrief/\npackage.json\n');
  const configFilePath = join(projectDir, SPLITBRIEF_DIR, CONFIG_FILE);
  const validation = options.validation ?? true;
  const lines = [
    'version: 3',
    'planner:',
    '  kind: shell',
    "  command: 'true'",
    '  outputFormat: text',
    '  model: shell',
    '  contextLength: 32768',
    'implementer:',
    '  kind: api',
    '  provider: ollama',
    '  apiBase: http://localhost:11434/v1',
    '  model: qwen2.5-coder:7b',
    '  contextLength: 32768',
    'validation:',
    `  typecheck: ${validation ? 'true' : 'false'}`,
    `  lint: ${validation ? 'true' : 'false'}`,
    `  test: ${validation ? 'true' : 'false'}`,
  ];
  if (validation) {
    lines.push(
      '  typecheckCommand: node -e ""',
      '  lintCommand: node -e ""',
      '  testCommand: node -e ""',
    );
  }
  lines.push(
    'workflow:',
    '  approve: default',
    '  maxRetries: 3',
    `  persistTranscript: ${options.persistTranscript ?? true}`,
    '  mode: standard',
  );
  if (options.codebase === false) {
    lines.push('codebase:', '  enabled: false');
  }
  writeFileSync(configFilePath, lines.join('\n'));
  chmodSync(configFilePath, 0o600);
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ scripts: { test: 'vitest run' } }, null, 2),
  );
}

export function readSingleSessionArtifact(projectDir: string, artifact: string): unknown {
  const sessionsDir = join(projectDir, SPLITBRIEF_DIR, 'sessions');
  const sessionIds = readdirSync(sessionsDir);
  if (sessionIds.length !== 1) {
    throw new Error(`expected exactly one session, found ${sessionIds.length}`);
  }
  return JSON.parse(readFileSync(join(sessionsDir, sessionIds[0] ?? '', artifact), 'utf-8'));
}
