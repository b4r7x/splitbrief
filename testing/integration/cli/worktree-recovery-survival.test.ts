import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getStartCommandTmp,
  prepareExecutionMock,
  runStart,
  setupStartCommandIntegration,
  writeReadyReadinessFixtures,
  runHeadlessMock,
} from '#testing/helpers/start-command.js';
import { cliError, isCliError } from '../../../src/cli/errors.js';
import { worktreePath } from '../../../src/core/paths.js';
import { createGitClient } from '../../../src/lib/git/client.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

setupStartCommandIntegration();

describe('start command — worktree survival on recovery vs startup failure', () => {
  let homeDir = '';
  let originalHome: string | undefined;

  beforeEach(() => {
    homeDir = createTempDir('worktree-recovery-survival-home');
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (homeDir) cleanupTempDir(homeDir);
    homeDir = '';
    vi.restoreAllMocks();
  });

  it('recovery_required exit leaves the run worktree and branch intact', async () => {
    const tmp = getStartCommandTmp();
    const slug = 'recovery-survival';
    writeReadyReadinessFixtures(tmp);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    runHeadlessMock.mockImplementationOnce(async () => {
      throw cliError(
        'Recovery required (status: awaiting-user): npm test failed Resolve it by choosing one of: skip-current-task, pause-run, abort-workflow.',
        1,
      );
    });

    let captured: unknown;
    try {
      await runStart([
        '--project',
        tmp,
        '--worktree',
        slug,
        '--json',
        '--mode',
        'quick',
        'implement X',
      ]);
      throw new Error('expected start to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('Recovery required');

    const wtPath = worktreePath(tmp, slug);
    await vi.waitFor(() => {
      expect(existsSync(wtPath)).toBe(true);
    });

    const git = createGitClient(tmp);
    expect((await git.branch()).all).toContain(`splitbrief/${slug}`);
    expect(existsSync(join(wtPath, '.git'))).toBe(true);
  });

  it('an interactive preparation failure still rolls the created worktree back', async () => {
    const tmp = getStartCommandTmp();
    const slug = 'interactive-rollback';
    writeReadyReadinessFixtures(tmp);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    prepareExecutionMock.mockRejectedValueOnce(cliError('runner preparation exploded', 1));

    let captured: unknown;
    try {
      await runStart(['--project', tmp, '--worktree', slug, 'implement X']);
      throw new Error('expected start to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message).toContain('runner preparation exploded');

    const wtPath = worktreePath(tmp, slug);
    await vi.waitFor(() => {
      expect(existsSync(join(wtPath, '.git'))).toBe(false);
    });

    const branchesAfterFailure = execSync(`git branch --list splitbrief/${slug}`, {
      cwd: tmp,
      encoding: 'utf-8',
    });
    expect(branchesAfterFailure.trim()).toBe('');
  }, 60_000);

  it('an interactive start that reaches the workflow keeps its worktree', async () => {
    const tmp = getStartCommandTmp();
    const slug = 'interactive-survives';
    writeReadyReadinessFixtures(tmp);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runStart(['--project', tmp, '--worktree', slug, 'implement X']);

    const wtPath = worktreePath(tmp, slug);
    expect(existsSync(join(wtPath, '.git'))).toBe(true);

    const git = createGitClient(tmp);
    expect((await git.branch()).all).toContain(`splitbrief/${slug}`);
  }, 60_000);
});
