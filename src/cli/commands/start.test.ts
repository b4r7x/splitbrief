import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { registerStartCommand } from './start.js';
import { CONFIG_FILE, DIPTYCH_DIR, STATE_FILE, worktreePath } from '../../core/paths.js';
import { isCliError } from '../errors.js';
import type { SpawnServerOptions } from '../../engine/ipc/spawn-server.js';

const spawnServerMock = vi.hoisted(() => vi.fn());
const runHeadlessMock = vi.hoisted(() => vi.fn());

vi.mock('../../engine/ipc/spawn-server.js', () => ({
  spawnServer: spawnServerMock,
}));

vi.mock('../headless.js', () => ({
  runHeadless: runHeadlessMock,
}));

vi.mock('../init-stores.js', () => ({
  initStores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../render.js', () => ({
  renderApp: vi.fn().mockResolvedValue(undefined),
}));

import { routerStore } from '../../stores/navigation/router.js';
import { spawnServer } from '../../engine/ipc/spawn-server.js';
import { renderApp } from '../render.js';
import { initStores } from '../init-stores.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('start-command-test');
  createTestGitRepo(tmp);
  routerStore.init({ screen: 'home' });
  vi.mocked(renderApp).mockClear();
  vi.mocked(initStores).mockClear();
  runHeadlessMock.mockClear();
  vi.mocked(spawnServer).mockImplementation(async (opts: SpawnServerOptions) => {
    mkdirSync(opts.sessionDir, { recursive: true });
    writeFileSync(
      join(opts.sessionDir, 'server-args.json'),
      JSON.stringify({
        sessionId: opts.sessionId,
        projectDir: opts.projectDir,
        feature: opts.feature,
        mode: opts.mode,
        configPath: opts.configPath,
        overrides: opts.overrides ?? {},
      }, null, 2),
    );
    return { ok: true, pid: 1234, sessionId: opts.sessionId };
  });
  runHeadlessMock.mockResolvedValue(undefined);
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
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
  writeFileSync(join(projectDir, DIPTYCH_DIR, CONFIG_FILE), '# test config marker\n');
}

function writeReadyReadinessFixtures(projectDir: string): void {
  mkdirSync(join(projectDir, DIPTYCH_DIR), { recursive: true });
  writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.diptych/\npackage.json\n');
  const configPath = join(projectDir, DIPTYCH_DIR, CONFIG_FILE);
  writeFileSync(configPath, [
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
    '  testCommand: npm test',
    'workflow:',
    '  approve: default',
    '  maxRetries: 3',
    '  persistTranscript: true',
    '  mode: standard',
  ].join('\n'));
  chmodSync(configPath, 0o600);
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }, null, 2));
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
  registerStartCommand(program);
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

  it('falls back to slug "session" when --worktree is bare and no feature is given', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree']);

    expect(existsSync(worktreePath(tmp, 'session'))).toBe(true);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('.trees/session');
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

  it('creates setup artifacts in the returned worktree path after createWorktree succeeds', async () => {
    const wtPath = worktreePath(tmp, 'my-feature');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree', 'my-feature', 'implement X']);

    expect(existsSync(join(wtPath, DIPTYCH_DIR, CONFIG_FILE))).toBe(true);
    expect(existsSync(join(tmp, DIPTYCH_DIR, CONFIG_FILE))).toBe(false);
  });

  it('applies --worktree before --detach creates detached session artifacts', async () => {
    const wtPath = worktreePath(tmp, 'detached-feature');
    vi.mocked(spawnServer).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree', 'detached-feature', '--detach', 'implement X']);

    const artifact = readOnlySessionArtifact(wtPath, 'server-args.json') as { projectDir?: string; configPath?: string };
    expect(artifact.projectDir).toBe(wtPath);
    expect(artifact.configPath).toBe(join(wtPath, DIPTYCH_DIR, CONFIG_FILE));

    const output = vi.mocked(console.log).mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain(`cd ${wtPath} && diptych attach`);
  });

  it('persists detached CLI overrides in the server args artifact', async () => {
    vi.mocked(spawnServer).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart([
      '--project', tmp,
      '--detach',
      '--planner', 'codex',
      '--planner-model', 'gpt-5',
      '--planner-command', 'plan-it',
      '--implementer', 'openrouter',
      '--implementer-model', 'qwen/qwen3-coder',
      '--implementer-command', 'build-it',
      '--model', 'alias-model',
      '--provider', 'deepseek',
      '--approve', 'all',
      '--budget', '4.25',
      '--planner-effort', 'high',
      '--mode', 'quick',
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
        planner: { tool: 'codex', model: 'gpt-5', command: 'plan-it' },
        implementer: { tool: 'openrouter', model: 'qwen/qwen3-coder', command: 'build-it' },
        autoApprove: true,
        approve: 'all',
        mode: 'quick',
        budget: 4.25,
        plannerEffort: 'high',
      },
    });
  });

  it('rejects --detach without a feature argument before creating any worktree', async () => {
    vi.mocked(spawnServer).mockClear();

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
    expect(vi.mocked(spawnServer)).not.toHaveBeenCalled();
  });

  it('rejects --detach + --json before creating any worktree', async () => {
    vi.mocked(spawnServer).mockClear();

    let captured: unknown;
    try {
      await runStart([
        '--project', tmp,
        '--worktree', 'combo',
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
    expect(vi.mocked(spawnServer)).not.toHaveBeenCalled();
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
    expect(runHeadlessMock).toHaveBeenCalledTimes(1);

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
    expect(firstLine.report?.sections?.flatMap(section => section.checks.map(check => check.id))).toContain('repo.active-session-live');
  });
});
