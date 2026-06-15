import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { execSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { registerStartCommand } from './start.js';
import type { StartDeps } from './start.js';
import {
  CONFIG_FILE,
  DIPTYCH_DIR,
  STATE_FILE,
  worktreePath,
  sessionDir,
} from '../../core/paths.js';
import { isCliError } from '../errors.js';
import type { SpawnServerOptions } from '../../engine/ipc/spawn-server.js';
import { parseIpcServerArgs } from '../../engine/ipc/server-args.js';
import { runHeadless } from '../headless.js';
import { readLockfile, checkServerStatus } from '../../engine/ipc/lockfile.js';

import { routerStore } from '../../stores/navigation/router.js';
import { MAX_SLUG_LENGTH } from '../../core/sessions/lifecycle.js';

const spawnServerMock =
  vi.fn<(opts: SpawnServerOptions) => Promise<{ ok: true; pid: number; sessionId: string }>>();
const runHeadlessMock = vi.fn<() => Promise<void>>();
const runRpcMock = vi.fn<() => Promise<void>>();
const initStoresMock: StartDeps['initStores'] = async () => {};
const renderCalls: Array<Parameters<StartDeps['renderApp']>[1]> = [];
const renderAppFake: StartDeps['renderApp'] = async (_app, options) => {
  renderCalls.push(options);
};

const fakeDeps: StartDeps = {
  spawnServer: spawnServerMock,
  runHeadless: runHeadlessMock as unknown as StartDeps['runHeadless'],
  runRpc: runRpcMock as unknown as StartDeps['runRpc'],
  initStores: initStoresMock,
  renderApp: renderAppFake,
};

let tmp: string;

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
      JSON.stringify(
        {
          sessionId: opts.sessionId,
          projectDir: opts.projectDir,
          feature: opts.feature,
          mode: opts.mode,
          configPath: opts.configPath,
          overrides: opts.overrides ?? {},
        },
        null,
        2,
      ),
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

/**
 * Write a session with a live phase + an active marker pointing at it.
 * Matches the production layout: .diptych/active + .diptych/sessions/<id>/state.json
 */
function writeLiveSession(projectDir: string, sessionId: string): void {
  const sessionDir = join(projectDir, DIPTYCH_DIR, 'sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, STATE_FILE),
    JSON.stringify({ feature: 'test', phase: 'implementing', tasks: [], currentTaskIndex: 0 }),
  );
  mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });
  writeFileSync(join(projectDir, DIPTYCH_DIR, 'active'), sessionId + '\n');
}

function writeConfigMarker(projectDir: string): void {
  mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });
  writeFileSync(
    join(projectDir, DIPTYCH_DIR, CONFIG_FILE),
    [
      'version: 3',
      'planner:',
      '  kind: cli',
      '  tool: claude-code',
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

function writeReadyReadinessFixtures(projectDir: string): void {
  mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });
  writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.diptych/\npackage.json\n');
  const configFilePath = join(projectDir, DIPTYCH_DIR, CONFIG_FILE);
  writeFileSync(
    configFilePath,
    [
      'version: 3',
      'planner:',
      '  kind: api',
      '  provider: ollama',
      '  apiBase: http://localhost:11434/v1',
      '  model: qwen2.5-coder:7b',
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
      'workflow:',
      '  approve: default',
      '  maxRetries: 3',
      '  persistTranscript: true',
      '  mode: standard',
    ].join('\n'),
  );
  chmodSync(configFilePath, 0o600);
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ scripts: { test: 'vitest run' } }, null, 2),
  );
}

function readOnlySessionArtifact(projectDir: string, artifact: string): unknown {
  const sessionsDir = join(projectDir, DIPTYCH_DIR, 'sessions');
  const sessionIds = readdirSync(sessionsDir);
  expect(sessionIds).toHaveLength(1);
  return JSON.parse(readFileSync(join(sessionsDir, sessionIds[0] ?? '', artifact), 'utf-8'));
}

async function runStart(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStartCommand(program, fakeDeps);
  await program.parseAsync(['node', 'diptych', 'start', ...args]);
}

describe('start command — concurrency guard', () => {
  it('refuses to start when a live session already exists and preserves the active marker', async () => {
    writeLiveSession(tmp, '2026-04-18-live');

    let captured: unknown;
    try {
      await runStart(['--project', tmp, 'another feature']);
      throw new Error('expected start to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message.length).toBeGreaterThan(0);
    const activePath = join(tmp, DIPTYCH_DIR, 'active');
    expect(existsSync(activePath)).toBe(true);
    expect(readFileSync(activePath, 'utf-8').trim()).toBe('2026-04-18-live');
  });
});

describe('start command — non-TTY preflight (F-321)', () => {
  it('fails fast without creating a session when stdin is not a TTY', async () => {
    writeConfigMarker(tmp);
    delete (process.stdin as { isTTY?: boolean }).isTTY;

    let captured: unknown;
    try {
      await runStart(['--project', tmp, 'implement X']);
      throw new Error('expected start to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('interactive mode needs a TTY');
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'active'))).toBe(false);
    expect(existsSync(join(tmp, DIPTYCH_DIR, 'sessions'))).toBe(false);
    expect(renderCalls).toEqual([]);
  });
});

describe('start command — session lifecycle during setup', () => {
  it('does not create a session when setup is needed, preventing orphaned sessions', async () => {
    await runStart(['--project', tmp, 'implement X']);

    expect(routerStore.get()).toMatchObject({ screen: 'setup', feature: 'implement X' });
    const activePath = join(tmp, DIPTYCH_DIR, 'active');
    expect(existsSync(activePath)).toBe(false);
    const sessionsDir = join(tmp, DIPTYCH_DIR, 'sessions');
    expect(existsSync(sessionsDir)).toBe(false);
  });

  it('creates a session when setup is not needed and feature is given', async () => {
    writeConfigMarker(tmp);

    await runStart(['--project', tmp, 'implement X']);

    expect(routerStore.get()).toMatchObject({ screen: 'workflow', feature: 'implement X' });
    const activePath = join(tmp, DIPTYCH_DIR, 'active');
    expect(existsSync(activePath)).toBe(true);
  });
});

describe('start command — --worktree flag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in an explicitly named worktree when --worktree my-feature is given', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree', 'my-feature', 'implement X']);

    expect(existsSync(worktreePath(tmp, 'my-feature'))).toBe(true);
    expect(routerStore.get()).toMatchObject({ screen: 'setup', feature: 'implement X' });
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('.trees/my-feature');
  });

  it('slugifies feature when --worktree is bare and feature is given', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Feature before flag so commander parses 'add auth' as positional, --worktree as bare
    await runStart(['--project', tmp, 'add auth', '--worktree']);

    expect(existsSync(worktreePath(tmp, 'add-auth'))).toBe(true);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('.trees/add-auth');
  });

  it('falls back to slug "unknown" when --worktree is bare and the feature is all-non-Latin', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // CJK feature slugifies to '', so the empty-slug fallback must produce 'unknown'
    await runStart(['--project', tmp, '機能を追加', '--worktree']);

    expect(existsSync(worktreePath(tmp, 'unknown'))).toBe(true);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('.trees/unknown');
  });

  it('falls back to slug "session" when --worktree is bare and no feature is given', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree']);

    expect(existsSync(worktreePath(tmp, 'session'))).toBe(true);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('.trees/session');
  });

  it('caps the derived slug at MAX_SLUG_LENGTH when --worktree is bare and the feature is long', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const feature = 'a'.repeat(MAX_SLUG_LENGTH + 10);
    await runStart(['--project', tmp, feature, '--worktree']);

    const cappedSlug = 'a'.repeat(MAX_SLUG_LENGTH);
    expect(existsSync(worktreePath(tmp, cappedSlug))).toBe(true);
    expect(existsSync(worktreePath(tmp, feature))).toBe(false);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain(`.trees/${cappedSlug}`);
  });

  it('bounds the derived slug to MAX_SLUG_LENGTH so the IPC socket path stays under the sun_path cap', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Far exceed the cap so the boundary is genuinely crossed and the derived
    // slug length stays bounded regardless of how long the feature grows.
    const feature = 'a'.repeat(MAX_SLUG_LENGTH * 4);
    await runStart(['--project', tmp, feature, '--worktree']);

    const cappedSlug = 'a'.repeat(MAX_SLUG_LENGTH);
    expect(cappedSlug.length).toBe(MAX_SLUG_LENGTH);
    expect(cappedSlug.length).toBeLessThan(feature.length);
    expect(existsSync(worktreePath(tmp, cappedSlug))).toBe(true);
    expect(existsSync(worktreePath(tmp, feature))).toBe(false);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain(`.trees/${cappedSlug}`);
  });

  it('wraps createWorktree errors as cliError with exitCode 1', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runStart(['--project', tmp, '--worktree', 'my-feature', 'implement X']);

    let captured: unknown;
    try {
      await runStart(['--project', tmp, '--worktree', 'my-feature']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode: number }).exitCode).toBe(1);
    expect((captured as Error).message).toContain('Branch diptych/my-feature already exists.');
  });

  it('requests setup in the returned worktree path without writing config when createWorktree succeeds', async () => {
    const wtPath = worktreePath(tmp, 'my-feature');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree', 'my-feature', 'implement X']);

    expect(existsSync(wtPath)).toBe(true);
    expect(routerStore.get()).toMatchObject({ screen: 'setup', feature: 'implement X' });
    // The default-config write is deferred to wizard completion, so the fresh
    // worktree carries no config yet, and none leaks into the base checkout.
    expect(existsSync(join(wtPath, DIPTYCH_DIR, CONFIG_FILE))).toBe(false);
    expect(existsSync(join(tmp, DIPTYCH_DIR, CONFIG_FILE))).toBe(false);
  });

  it('applies --worktree before --detach creates detached session artifacts', async () => {
    const wtPath = worktreePath(tmp, 'detached-feature');
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree', 'detached-feature', '--detach', 'implement X']);

    const artifact = readOnlySessionArtifact(wtPath, 'server-args.json') as {
      projectDir?: string;
      configPath?: string;
    };
    expect(artifact.projectDir).toBe(wtPath);
    expect(artifact.configPath).toBe(join(wtPath, DIPTYCH_DIR, CONFIG_FILE));

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => call.join(' '))
      .join('\n');
    expect(output).toContain(`cd ${wtPath} && diptych attach`);
  });

  it('persists detached CLI overrides in the server args artifact', async () => {
    writeReadyReadinessFixtures(tmp);
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.PLANNER_KEY = 'test-planner-key';
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart([
      '--project',
      tmp,
      '--detach',
      '--planner',
      'codex',
      '--planner-model',
      'gpt-5',
      '--planner-command',
      'plan-it',
      '--planner-api-base',
      'https://planner.example/v1',
      '--planner-api-key-env',
      'PLANNER_KEY',
      '--planner-args',
      '--planner-json',
      '--planner-output-format',
      'stream-json',
      '--planner-context-length',
      '200000',
      '--implementer',
      'openrouter',
      '--implementer-model',
      'qwen/qwen3-coder',
      '--implementer-command',
      'build-it',
      '--implementer-api-base',
      'https://openrouter.ai/api/v1',
      '--implementer-api-key-env',
      'OPENROUTER_API_KEY',
      '--implementer-args',
      '--cheap-mode',
      '--implementer-args',
      'fast',
      '--implementer-output-format',
      'opencode',
      '--implementer-context-length',
      '131072',
      '--model',
      'alias-model',
      '--provider',
      'deepseek',
      '--approve',
      'all',
      '--budget',
      '4.25',
      '--planner-effort',
      'high',
      '--mode',
      'quick',
      '--auto',
      'implement X',
    ]);

    const artifact = readOnlySessionArtifact(tmp, 'server-args.json') as {
      mode?: string;
      configPath?: string;
      overrides?: unknown;
    };
    expect(artifact).toMatchObject({
      mode: 'quick',
      configPath: join(tmp, DIPTYCH_DIR, CONFIG_FILE),
      overrides: {
        planner: {
          tool: 'codex',
          model: 'gpt-5',
          command: 'plan-it',
          apiBase: 'https://planner.example/v1',
          apiKey: 'env:PLANNER_KEY',
          args: ['--planner-json'],
          outputFormat: 'stream-json',
          contextLength: 200_000,
        },
        implementer: {
          tool: 'openrouter',
          model: 'qwen/qwen3-coder',
          command: 'build-it',
          apiBase: 'https://openrouter.ai/api/v1',
          apiKey: 'env:OPENROUTER_API_KEY',
          args: ['--cheap-mode', 'fast'],
          outputFormat: 'opencode',
          contextLength: 131_072,
        },
        autoApprove: true,
        approve: 'all',
        mode: 'quick',
        budget: 4.25,
        plannerEffort: 'high',
      },
    });
  });

  it('prints config load warnings to stderr on the detached path before spawning the server', async () => {
    writeReadyReadinessFixtures(tmp);
    const configFilePath = join(tmp, DIPTYCH_DIR, CONFIG_FILE);
    writeFileSync(
      configFilePath,
      [
        'version: 2',
        'planner:',
        '  kind: api',
        '  provider: ollama',
        '  apiBase: http://localhost:11434/v1',
        '  model: qwen2.5-coder:7b',
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
        'workflow:',
        '  approve: default',
        '  maxRetries: 3',
        '  persistTranscript: true',
        '  mode: standard',
      ].join('\n'),
    );
    chmodSync(configFilePath, 0o600);
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderrChunks: string[] = [];
    let warningsBeforeSpawn = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    spawnServerMock.mockImplementationOnce(async (opts: SpawnServerOptions) => {
      warningsBeforeSpawn = stderrChunks.join('');
      mkdirSync(opts.sessionDir, { recursive: true });
      return { ok: true, pid: 1234, sessionId: opts.sessionId };
    });

    await runStart(['--project', tmp, '--detach', 'implement X']);

    expect(spawnServerMock).toHaveBeenCalledTimes(1);
    expect(warningsBeforeSpawn).toContain('config.version 2 is deprecated');
  });

  it('normalizes the legacy --mode full alias through nested detached overrides', async () => {
    spawnServerMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--detach', '--mode', 'full', 'implement X']);

    const artifact = readOnlySessionArtifact(tmp, 'server-args.json');
    const parsed = parseIpcServerArgs(artifact);

    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe('speckit');
    expect(parsed?.overrides.mode).toBe('speckit');
  });

  it('rolls back the worktree and branch when server spawn fails, so the same command can be retried (F-187)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const spawnFailure = { ok: false, reason: 'boom' } as unknown as Awaited<
      ReturnType<typeof spawnServerMock>
    >;
    spawnServerMock.mockImplementationOnce(async () => spawnFailure);

    let captured: unknown;
    try {
      await runStart(['--project', tmp, '--worktree', 'retry-me', '--detach', 'implement X']);
      throw new Error('expected start to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('Failed to start server');
    expect(existsSync(worktreePath(tmp, 'retry-me'))).toBe(false);
    const branchesAfterFailure = execSync('git branch --list diptych/retry-me', {
      cwd: tmp,
      encoding: 'utf-8',
    });
    expect(branchesAfterFailure.trim()).toBe('');

    await runStart(['--project', tmp, '--worktree', 'retry-me', '--detach', 'implement X']);

    expect(existsSync(worktreePath(tmp, 'retry-me'))).toBe(true);
    const wtPath = worktreePath(tmp, 'retry-me');
    const artifact = readOnlySessionArtifact(wtPath, 'server-args.json') as {
      projectDir?: string;
    };
    expect(artifact.projectDir).toBe(wtPath);
  });

  it('rejects --detach without a feature argument before creating any worktree', async () => {
    spawnServerMock.mockClear();

    let captured: unknown;
    try {
      await runStart(['--project', tmp, '--worktree', 'orphan', '--detach']);
      throw new Error('expected start to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('--detach requires a feature');
    expect(existsSync(worktreePath(tmp, 'orphan'))).toBe(false);
    expect(spawnServerMock).not.toHaveBeenCalled();
  });

  it('rejects --detach + --json before creating any worktree', async () => {
    spawnServerMock.mockClear();

    let captured: unknown;
    try {
      await runStart([
        '--project',
        tmp,
        '--worktree',
        'combo',
        '--detach',
        '--json',
        'implement X',
      ]);
      throw new Error('expected start to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('--detach and --json cannot be combined');
    expect(existsSync(worktreePath(tmp, 'combo'))).toBe(false);
    expect(spawnServerMock).not.toHaveBeenCalled();
  });
});

describe('start command — worktree indicator passthrough', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes workflow with worktreeName=slug when started inside a git worktree', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runStart(['--project', tmp, '--worktree', 'my-feature', 'prepare branch']);
    const wtPath = worktreePath(tmp, 'my-feature');
    // A completed wizard leaves a config on disk; without it the deferred-setup
    // gate would route to 'setup' instead of exercising worktree passthrough.
    writeConfigMarker(wtPath);
    routerStore.init({ screen: 'home' });

    await runStart(['--project', wtPath, 'implement X']);

    expect(routerStore.get()).toMatchObject({ screen: 'workflow', worktreeName: 'my-feature' });
  });

  it('routes workflow without worktreeName when started in the base repository', async () => {
    writeConfigMarker(tmp);

    await runStart(['--project', tmp, 'implement X']);

    expect(routerStore.get()).toMatchObject({ screen: 'workflow', worktreeName: undefined });
  });
});

describe('start command — readiness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints blockers only during normal start readiness failures', async () => {
    writeReadyReadinessFixtures(tmp);
    writeLiveSession(tmp, '2026-04-28-live');
    writeFileSync(join(tmp, 'scratch.txt'), 'local edit');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    let captured: unknown;
    try {
      await runStart(['--project', tmp, 'implement X']);
    } catch (err) {
      captured = err;
    }

    const output = consoleSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(isCliError(captured)).toBe(true);
    expect(output).toContain('repo.active-session-live');
    expect(output).not.toContain('repo.dirty-worktree');
    expect(output).not.toContain('scratch.txt');
    expect(renderCalls).toEqual([]);
  });

  it('throws a one-line pointer instead of re-listing every blocker in the error message', async () => {
    writeReadyReadinessFixtures(tmp);
    writeLiveSession(tmp, '2026-04-28-live');
    writeFileSync(join(tmp, 'scratch.txt'), 'local edit');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    let captured: unknown;
    try {
      await runStart(['--project', tmp, 'implement X']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    const message = (captured as Error).message;
    expect(message).toContain('Run readiness blocked');
    expect(message).toContain('blocker');
    expect(message.split('\n')).toHaveLength(1);
    expect(message).not.toContain('repo.active-session-live');
  });

  it('emits readiness before headless workflow execution and persists compact session evidence', async () => {
    writeReadyReadinessFixtures(tmp);
    const stdoutChunks: string[] = [];
    let writesBeforeWorkflow = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    runHeadlessMock.mockImplementation(async () => {
      writesBeforeWorkflow = stdoutChunks.length;
    });

    await runStart(['--project', tmp, '--json', 'implement X']);

    expect(writesBeforeWorkflow).toBeGreaterThan(0);
    const firstLine = JSON.parse(stdoutChunks[0]?.trim() ?? '{}') as {
      type?: string;
      report?: { status?: string; nextAction?: { kind?: string } };
    };
    expect(firstLine.type).toBe('readiness_report');
    expect(firstLine.report?.status).toBe('ready');

    const readinessRecord = readOnlySessionArtifact(tmp, 'readiness.json') as {
      type?: string;
      status?: string;
      warningCount?: number;
    };
    expect(readinessRecord.type).toBe('start-readiness');
    expect(readinessRecord.status).toBe('ready');
    expect(readinessRecord.warningCount).toBe(0);
  });

  it('blocks headless start before workflow execution when readiness has a blocker', async () => {
    writeConfigMarker(tmp);
    writeLiveSession(tmp, '2026-04-28-live');
    const stdoutChunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    let captured: unknown;
    try {
      await runStart(['--project', tmp, '--json', 'implement X']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect(runHeadlessMock).not.toHaveBeenCalled();
    const firstLine = JSON.parse(stdoutChunks[0]?.trim() ?? '{}') as {
      report?: { status?: string; sections?: Array<{ checks: Array<{ id: string }> }> };
    };
    expect(firstLine.report?.status).toBe('blocked');
    expect(
      firstLine.report?.sections?.flatMap((section) => section.checks.map((check) => check.id)),
    ).toContain('repo.active-session-live');
  });

  it('emits readiness before RPC workflow execution and persists compact session evidence', async () => {
    writeReadyReadinessFixtures(tmp);
    const stdoutChunks: string[] = [];
    let writesBeforeWorkflow = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    runRpcMock.mockImplementation(async () => {
      writesBeforeWorkflow = stdoutChunks.length;
    });

    await runStart(['--project', tmp, '--rpc', 'implement X']);

    expect(writesBeforeWorkflow).toBeGreaterThan(0);
    const firstLine = JSON.parse(stdoutChunks[0]?.trim() ?? '{}') as {
      type?: string;
      data?: { type?: string; report?: { status?: string } };
    };
    expect(firstLine.type).toBe('status');
    expect(firstLine.data?.type).toBe('readiness_report');
    expect(firstLine.data?.report?.status).toBe('ready');

    const readinessRecord = readOnlySessionArtifact(tmp, 'readiness.json') as {
      type?: string;
      status?: string;
    };
    expect(readinessRecord.type).toBe('start-readiness');
    expect(readinessRecord.status).toBe('ready');
  });

  it('rejects --json and --rpc together before workflow execution', async () => {
    let captured: unknown;
    try {
      await runStart(['--project', tmp, '--json', '--rpc', 'implement X']);
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('--json and --rpc cannot be combined');
    expect(runHeadlessMock).not.toHaveBeenCalled();
    expect(runRpcMock).not.toHaveBeenCalled();
  });
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

  it('does not hijack explicit subcommands registered on the same program', async () => {
    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);

    let specCalled = false;
    program.command('spec').action(() => {
      specCalled = true;
    });
    await program.parseAsync(['node', 'diptych', 'spec']);

    expect(specCalled).toBe(true);
    expect(renderCalls).toEqual([]);
  });

  it('passes workflow options through shorthand invocation', async () => {
    writeConfigMarker(tmp);

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
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
  });
});

describe('start command — liveness record (F-261)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function onlySessionId(projectDir: string): string {
    const sessionsDir = join(projectDir, DIPTYCH_DIR, 'sessions');
    const ids = readdirSync(sessionsDir);
    expect(ids).toHaveLength(1);
    return ids[0] ?? '';
  }

  it('creates and then releases a liveness record across a real headless start run', async () => {
    writeReadyReadinessFixtures(tmp);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const briefCompleteTask = makeTask({
      id: 'T001',
      action: 'create',
      file: 'src/example.ts',
      description: 'Add a single example function to src/example.ts',
      tests: ['verifies the example function returns the expected value for the documented input'],
      constraints: ['keep the change confined to the example function'],
      typeDefs: 'export function example(): void',
      implementationSteps: ['1. Add the example function', '2. Export it from src/example.ts'],
      scope: { inBounds: ['the example function'], outOfBounds: ['unrelated modules'] },
      evidence: ['the new function is exported and importable'],
    });
    const planner = makePlanner({
      quickPlan: vi.fn().mockResolvedValue({
        spec: '',
        plan: '',
        tasks: [briefCompleteTask],
        usage: { inputTokens: 50, outputTokens: 25 },
      }),
    });
    const implementer = makeImplementer();
    let midRunPid: number | undefined;
    let midRunExitedAt: number | undefined;
    implementer.implement = vi.fn().mockImplementation(async () => {
      const lock = await readLockfile(sessionDir(tmp, onlySessionId(tmp)));
      midRunPid = lock?.pid;
      midRunExitedAt = lock?.exitedAt;
      return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
    });

    const realHeadlessDeps: StartDeps = {
      ...fakeDeps,
      runHeadless: (options) =>
        runHeadless({ ...options, _planner: planner, _implementer: implementer }),
    };

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, realHeadlessDeps);
    await program.parseAsync([
      'node',
      'diptych',
      'start',
      '--json',
      '--mode',
      'quick',
      'implement X',
      '--project',
      tmp,
    ]);

    const sessionId = onlySessionId(tmp);
    const dir = sessionDir(tmp, sessionId);

    expect(midRunPid).toBe(process.pid);
    expect(midRunExitedAt).toBeUndefined();

    let status = await checkServerStatus(dir);
    for (let i = 0; i < 50 && status.alive; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await checkServerStatus(dir);
    }
    expect(status.alive).toBe(false);
    const lock = await readLockfile(dir);
    expect(lock?.exitedAt).toBeDefined();
  });
});

describe('start command — @file syntax', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('separates @file content into plannerContext, not feature', async () => {
    writeConfigMarker(tmp);
    writeFileSync(join(tmp, 'brief.md'), 'Context about the feature.');

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    await program.parseAsync([
      'node',
      'diptych',
      'start',
      'build it',
      '@brief.md',
      '--project',
      tmp,
    ]);

    expect(routerStore.get()).toMatchObject({ screen: 'workflow' });
    const route = routerStore.get() as { feature?: string; plannerContext?: string };
    expect(route.feature ?? '').toContain('build it');
    expect(route.feature ?? '').not.toContain('Context about the feature.');
    expect(route.plannerContext ?? '').toContain('Context about the feature.');
  });

  it('warns on stderr for missing @file without aborting', async () => {
    writeConfigMarker(tmp);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);
    await program.parseAsync([
      'node',
      'diptych',
      'start',
      'build it',
      '@ghost.md',
      '--project',
      tmp,
    ]);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('@ghost.md'));
    expect(routerStore.get().screen).toBe('workflow');
  });
});
