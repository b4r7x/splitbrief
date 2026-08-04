import { afterEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getStartCommandTmp,
  readSingleSessionArtifact,
  runStart,
  setupStartCommandIntegration,
  spawnServerMock,
  writeConfigMarker,
  writeReadyReadinessFixtures,
} from '#testing/helpers/start-command.js';
import { CONFIG_FILE, SPLITBRIEF_DIR, worktreePath } from '../../../src/core/paths.js';
import { isCliError } from '../../../src/cli/errors.js';
import { MAX_SLUG_LENGTH } from '../../../src/core/sessions/lifecycle.js';
import { routerStore } from '../../../src/stores/navigation/router.js';
import type { SpawnServerResult } from '../../../src/engine/ipc/spawn-server.js';

setupStartCommandIntegration();

describe('start command — --worktree flag', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('slugifies feature when --worktree is bare and feature is given', async () => {
    const tmp = getStartCommandTmp();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, 'add auth', '--worktree']);

    expect(existsSync(worktreePath(tmp, 'add-auth'))).toBe(true);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('.trees/add-auth');
  });

  it('falls back to slug "unknown" when --worktree is bare and the feature is all-non-Latin', async () => {
    const tmp = getStartCommandTmp();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '機能を追加', '--worktree']);

    expect(existsSync(worktreePath(tmp, 'unknown'))).toBe(true);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('.trees/unknown');
  });

  it('falls back to slug "session" when --worktree is bare and no feature is given', async () => {
    const tmp = getStartCommandTmp();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree']);

    expect(existsSync(worktreePath(tmp, 'session'))).toBe(true);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('.trees/session');
  });

  it('caps the derived slug at MAX_SLUG_LENGTH when --worktree is bare and the feature is long', async () => {
    const tmp = getStartCommandTmp();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const feature = 'a'.repeat(MAX_SLUG_LENGTH + 10);
    await runStart(['--project', tmp, feature, '--worktree']);

    const cappedSlug = 'a'.repeat(MAX_SLUG_LENGTH);
    expect(existsSync(worktreePath(tmp, cappedSlug))).toBe(true);
    expect(existsSync(worktreePath(tmp, feature))).toBe(false);
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain(`.trees/${cappedSlug}`);
  });

  it('wraps createWorktree errors as cliError with exitCode 1', async () => {
    const tmp = getStartCommandTmp();
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
    expect((captured as Error).message).toContain('Branch splitbrief/my-feature already exists.');
  });

  it('requests setup in the returned worktree path without writing config when createWorktree succeeds', async () => {
    const tmp = getStartCommandTmp();
    const wtPath = worktreePath(tmp, 'my-feature');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree', 'my-feature', 'implement X']);

    expect(existsSync(wtPath)).toBe(true);
    expect(routerStore.get()).toMatchObject({ screen: 'setup', feature: 'implement X' });
    expect(consoleSpy.mock.calls.flat().join(' ')).toContain('.trees/my-feature');
    expect(existsSync(join(wtPath, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);
  });

  it('rolls back the worktree and branch when server spawn fails, so the same command can be retried', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const spawnFailure: SpawnServerResult = { ok: false, reason: 'boom' };
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
    const branchesAfterFailure = execSync('git branch --list splitbrief/retry-me', {
      cwd: tmp,
      encoding: 'utf-8',
    });
    expect(branchesAfterFailure.trim()).toBe('');

    await runStart(['--project', tmp, '--worktree', 'retry-me', '--detach', 'implement X']);

    expect(existsSync(worktreePath(tmp, 'retry-me'))).toBe(true);
    const wtPath = worktreePath(tmp, 'retry-me');
    const artifact = readSingleSessionArtifact(wtPath, 'server-args.json') as {
      projectDir?: string;
    };
    expect(artifact.projectDir).toBe(wtPath);
  }, 60_000);

  it('rejects --detach without a feature argument before creating any worktree', async () => {
    const tmp = getStartCommandTmp();
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
    const tmp = getStartCommandTmp();
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
    const tmp = getStartCommandTmp();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await runStart(['--project', tmp, '--worktree', 'my-feature', 'prepare branch']);
    const wtPath = worktreePath(tmp, 'my-feature');
    writeConfigMarker(wtPath);
    routerStore.init({ screen: 'home' });

    await runStart(['--project', wtPath, 'implement X']);

    expect(routerStore.get()).toMatchObject({
      screen: 'workflow',
      execution: {
        kind: 'local',
        prepared: { runtime: { worktreeName: 'my-feature' } },
      },
    });
  });

  it('routes workflow without worktreeName when started in the base repository', async () => {
    const tmp = getStartCommandTmp();
    writeConfigMarker(tmp);

    await runStart(['--project', tmp, 'implement X']);

    const route = routerStore.get();
    expect(route).toMatchObject({ screen: 'workflow', execution: { kind: 'local' } });
    if (route.screen !== 'workflow' || route.execution.kind !== 'local') {
      throw new Error('Expected a prepared local workflow route');
    }
    expect(route.execution.prepared.runtime.worktreeName).toBeUndefined();
  });
});
