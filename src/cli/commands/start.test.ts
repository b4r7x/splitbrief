import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { registerStartCommand } from './start.js';
import { DIPTYCH_DIR, STATE_FILE } from '../../core/paths.js';
import { isCliError } from '../errors.js';

vi.mock('../../engine/git/worktree.js', () => ({
  createWorktree: vi.fn(),
  detectWorktree: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../core/migration/executor.js', () => ({
  maybeMigrate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../setup.js')>();
  return {
    ...actual,
    setupWorkflow: vi.fn().mockResolvedValue({ useFullscreen: false, useMouse: false }),
    ensureGitAndConfig: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../init-stores.js', () => ({
  initStores: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../render.js', () => ({
  renderApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../stores/navigation/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/navigation/router.js')>();
  return {
    ...actual,
    routerStore: { init: vi.fn() },
  };
});

vi.mock('../../core/sessions/lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/sessions/lifecycle.js')>();
  return {
    ...actual,
    beginSession: vi.fn().mockReturnValue('test-session-id'),
  };
});

import { createWorktree, detectWorktree } from '../../engine/git/worktree.js';
import { setupWorkflow } from '../setup.js';
import { maybeMigrate } from '../../core/migration/executor.js';
import { routerStore } from '../../stores/navigation/router.js';

let tmp: string;

beforeEach(() => {
  tmp = createTempDir('start-command-test');
  createTestGitRepo(tmp);
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
  beforeEach(() => {
    vi.mocked(createWorktree).mockReset();
    vi.mocked(setupWorkflow).mockResolvedValue({ useFullscreen: false, useMouse: false, projectDir: tmp });
  });

  it('passes explicit slug to createWorktree when --worktree my-feature is given', async () => {
    vi.mocked(createWorktree).mockResolvedValue(`${tmp}/.trees/my-feature`);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree', 'my-feature', 'implement X']);

    expect(vi.mocked(createWorktree)).toHaveBeenCalledOnce();
    const callArg = vi.mocked(createWorktree).mock.calls[0]?.[0];
    expect(callArg?.slug).toBe('my-feature');
    expect(callArg?.projectDir).toBe(tmp);

    vi.restoreAllMocks();
  });

  it('slugifies feature when --worktree is bare and feature is given', async () => {
    const wtPath = `${tmp}/.trees/add-auth`;
    vi.mocked(createWorktree).mockResolvedValue(wtPath);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    let capturedSlug: string | undefined;
    vi.mocked(createWorktree).mockImplementation(async (o) => {
      capturedSlug = o.slug;
      return wtPath;
    });

    // Feature before flag so commander parses 'add auth' as positional, --worktree as bare
    await runStart(['--project', tmp, 'add auth', '--worktree']);

    expect(capturedSlug).toBe('add-auth');
    vi.restoreAllMocks();
  });

  it('falls back to slug "session" when --worktree is bare and no feature is given', async () => {
    const wtPath = `${tmp}/.trees/session`;
    vi.mocked(createWorktree).mockResolvedValue(wtPath);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Simulate bare --worktree (commander sets opts.worktree = true)
    // We test this by directly invoking the action handler logic through a custom program
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });

    let capturedSlug: string | undefined;
    vi.mocked(createWorktree).mockImplementation(async (opts) => {
      capturedSlug = opts.slug;
      return wtPath;
    });

    registerStartCommand(program);
    // Pass --worktree with no value — commander sets opts.worktree = true (boolean)
    await program.parseAsync(['node', 'diptych', 'start', '--project', tmp, '--worktree']);

    expect(capturedSlug).toBe('session');
    vi.restoreAllMocks();
  });

  it('wraps createWorktree errors as cliError with exitCode 1', async () => {
    vi.mocked(createWorktree).mockRejectedValue(
      new Error('Branch diptych/my-feature already exists.'),
    );

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

  it('sets opts.project to the returned worktree path after createWorktree succeeds', async () => {
    const wtPath = `${tmp}/.trees/my-feature`;
    vi.mocked(createWorktree).mockResolvedValue(wtPath);
    vi.mocked(maybeMigrate).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStart(['--project', tmp, '--worktree', 'my-feature', 'implement X']);

    // maybeMigrate is called with resolveProjectDir(opts.project) — after the worktree block
    // sets opts.project = wtPath, so maybeMigrate receives wtPath
    expect(vi.mocked(maybeMigrate)).toHaveBeenCalledOnce();
    expect(vi.mocked(maybeMigrate).mock.calls[0]?.[0]).toBe(wtPath);

    vi.restoreAllMocks();
  });
});

describe('start command — worktree indicator passthrough', () => {
  beforeEach(() => {
    vi.mocked(setupWorkflow).mockResolvedValue({ useFullscreen: false, useMouse: false, projectDir: tmp });
    vi.mocked(detectWorktree).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes worktreeName=slug to routerStore.init when detectWorktree resolves to a slug', async () => {
    vi.mocked(detectWorktree).mockResolvedValue('my-feature');

    await runStart(['--project', tmp, 'implement X']);

    expect(vi.mocked(routerStore.init)).toHaveBeenCalledWith(
      expect.objectContaining({ screen: 'workflow', worktreeName: 'my-feature' }),
    );
  });

  it('passes worktreeName=undefined to routerStore.init when detectWorktree rejects', async () => {
    vi.mocked(detectWorktree).mockRejectedValue(new Error('git error'));

    await runStart(['--project', tmp, 'implement X']);

    expect(vi.mocked(routerStore.init)).toHaveBeenCalledWith(
      expect.objectContaining({ screen: 'workflow', worktreeName: undefined }),
    );
  });

  it('passes worktreeName=undefined to routerStore.init when detectWorktree returns null', async () => {
    vi.mocked(detectWorktree).mockResolvedValue(null);

    await runStart(['--project', tmp, 'implement X']);

    expect(vi.mocked(routerStore.init)).toHaveBeenCalledWith(
      expect.objectContaining({ screen: 'workflow', worktreeName: undefined }),
    );
  });
});
