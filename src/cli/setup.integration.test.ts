import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  assertInteractiveTty,
  canonicalizeProjectDir,
  loadConfigOrExit,
  setupWorkflow,
} from './setup.js';
import { SPLITBRIEF_DIR, CONFIG_FILE, LOCKFILE, sessionDir } from '../core/paths.js';
import { readRunnerPids } from '../core/sessions/runner-pids.js';
import { canSignalProcess } from '../lib/process/liveness.js';
import { killOrphanRunner, plantOrphanRunner } from '#testing/helpers/orphan-runner.js';
import { isCliError } from './errors.js';
import { toErrorMessage } from '../utils/format-errors.js';
import { execFileSync } from 'node:child_process';
import type { WorkflowState } from '../core/schemas/workflow.js';
import { createInitialState, transition } from '../core/state/machine.js';
import { saveState } from '../core/state/persistence.js';
import { ensureSessionDir } from '../core/paths-io.js';
import { readWorkspaceRecord } from '../engine/orchestrator/isolation/retention.js';
import { closeRunIfOpen } from '../engine/orchestrator/run/close.js';
import { RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { startWorkspaceRun } from '#testing/helpers/workspace-run.js';

let tmp: string;
// console.log is a sanctioned global spy — see docs/TESTING.md core rules.
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = createTempDir('setup-workflow-test');
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  consoleSpy.mockRestore();
});

describe('setupWorkflow', () => {
  it('throws a CLI error when the project is not a git repository', async () => {
    // tmp exists but no `git init` yet.
    let captured: unknown;
    try {
      await setupWorkflow({ project: tmp, fullscreen: false });
      throw new Error('expected setupWorkflow to throw');
    } catch (err) {
      captured = err;
    }
    expect(isCliError(captured)).toBe(true);
    expect((captured as Error).message.length).toBeGreaterThan(0);
  });

  it('signals needsSetup WITHOUT writing config when no config exists and no runner overrides are passed', async () => {
    createTestGitRepo(tmp);

    const result = await setupWorkflow({ project: tmp, fullscreen: false });

    expect(result.needsSetup).toBe(true);
    // The default config write is deferred to wizard completion; an abandoned
    // wizard must leave no config on disk so setup is re-requested next time.
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);
  });

  it.each([
    { label: 'planner', opts: { planner: 'claude-code' } },
    { label: 'implementer', opts: { implementer: 'ollama' } },
  ] as const)(
    'requests setup without writing config when a $label override is provided',
    async ({ opts }) => {
      createTestGitRepo(tmp);

      const result = await setupWorkflow({ project: tmp, fullscreen: false, ...opts });

      expect(result.needsSetup).toBe(true);
      expect(existsSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);
    },
  );

  it('still requests setup when non-runner flags are the only extras', async () => {
    createTestGitRepo(tmp);

    const mode = await setupWorkflow({ project: tmp, fullscreen: false });
    expect(mode.needsSetup).toBe(true);
  });

  it('re-requests setup on a second call when the first wizard was abandoned (no config written)', async () => {
    createTestGitRepo(tmp);

    const first = await setupWorkflow({ project: tmp, fullscreen: false });
    expect(first.needsSetup).toBe(true);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);

    const second = await setupWorkflow({ project: tmp, fullscreen: false });
    expect(second.needsSetup).toBe(true);
  });

  it('does NOT request setup when a config already exists on disk', async () => {
    createTestGitRepo(tmp);
    mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
    writeFileSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE), 'version: 3\n');
    const first = await setupWorkflow({ project: tmp, fullscreen: false, planner: 'claude-code' });
    expect(first.needsSetup).toBeUndefined();
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(true);

    const second = await setupWorkflow({ project: tmp, fullscreen: false });
    expect(second.needsSetup).toBeUndefined();
  });

  it('canonicalizes a repo SUBDIRECTORY to the git toplevel so state is not split per-cwd', async () => {
    createTestGitRepo(tmp);
    const subdir = join(tmp, 'packages', 'web');
    mkdirSync(subdir, { recursive: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await setupWorkflow({
      project: subdir,
      fullscreen: false,
      planner: 'claude-code',
    });

    expect(result.projectDir).not.toBe(subdir);
    expect(result.projectDir).toBe(realpathSync(tmp));
    expect(result.needsSetup).toBe(true);
    expect(existsSync(join(result.projectDir, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);
    expect(existsSync(join(subdir, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);
    errorSpy.mockRestore();
  });

  it('reaps a tool a crashed run of this project left running', async () => {
    createTestGitRepo(tmp);
    const projectDir = realpathSync(tmp);
    const ref = { projectDir, sessionId: 'crashed-session' };
    mkdirSync(sessionDir(projectDir, ref.sessionId), { recursive: true });
    // A pid above every kernel's pid_max: the run's owner is dead.
    writeFileSync(
      join(sessionDir(projectDir, ref.sessionId), LOCKFILE),
      JSON.stringify({
        version: 1,
        pid: 2_147_483_000,
        startTimeMs: 1000,
        lastAliveMs: Date.now(),
        sessionId: ref.sessionId,
        feature: 'feature',
      }),
    );
    const orphan = plantOrphanRunner(ref);

    try {
      await setupWorkflow({ project: tmp, fullscreen: false });

      expect(canSignalProcess(orphan)).toBe(false);
      expect(readRunnerPids(ref)).toEqual([]);
    } finally {
      killOrphanRunner(orphan);
    }
  });

  const runId = '2026-10-25-leftover-run';
  const kept = { workspace: true, worktrees: 1, record: true, stderr: '' };
  const gone = { workspace: false, worktrees: 0, record: false, stderr: '' };

  async function workspaceRun(
    dirs: string[],
    strategy: 'worktree' | 'staged-copy',
    next: (state: WorkflowState) => WorkflowState,
  ) {
    const run = await startWorkspaceRun({ strategy, sessionId: runId, dirs });
    saveState(run.ref, next(run.state));
    return { projectDir: run.ref.projectDir, workspaceDir: run.workspaceDir };
  }

  function checkoutRun(dirs: string[], checkoutMode: boolean) {
    const projectDir = realpathSync(createTempDir('setup-closed-checkout'));
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    ensureSessionDir(projectDir, runId);
    const state: WorkflowState = {
      ...createInitialState('Checkout run'),
      ...RUN_CREW,
      phase: 'implementing',
      ...(checkoutMode && {
        workspace: { kind: 'checkout', path: projectDir, base: { snapshotId: 'base', head: null } },
      }),
    };
    saveState({ projectDir, sessionId: runId }, transition(state, { type: 'CLOSE_RUN' }));
    return { projectDir, workspaceDir: null };
  }

  const close = (state: WorkflowState) => transition(state, { type: 'CLOSE_RUN' });

  it.each([
    {
      label: 'a start removes a closed worktree run with its record',
      arrange: (dirs: string[]) => workspaceRun(dirs, 'worktree', close),
      expected: gone,
    },
    {
      label: 'a start removes a closed staged-copy run with its record',
      arrange: (dirs: string[]) => workspaceRun(dirs, 'staged-copy', close),
      expected: gone,
    },
    {
      label: 'a start goes past an unreadable run and removes a closed run with its record',
      arrange: async (dirs: string[]) => {
        const run = await workspaceRun(dirs, 'worktree', close);
        ensureSessionDir(run.projectDir, '2026-10-25-broken-run');
        writeFileSync(
          join(sessionDir(run.projectDir, '2026-10-25-broken-run'), 'state.json'),
          '{not json',
        );
        return run;
      },
      expected: {
        ...gone,
        stderr:
          'Warning: skipped .splitbrief/sessions/2026-10-25-broken-run/state.json: it could not be read\n',
      },
    },
    {
      label: 'a start skips a closed run whose record is already gone',
      arrange: async (dirs: string[]) => {
        const run = await startWorkspaceRun({ strategy: 'worktree', sessionId: runId, dirs });
        await closeRunIfOpen(run.ref, run.state);
        return { projectDir: run.ref.projectDir, workspaceDir: run.workspaceDir };
      },
      expected: gone,
    },
    {
      label: 'a start skips a closed checkout-mode run',
      arrange: async (dirs: string[]) => checkoutRun(dirs, true),
      expected: gone,
    },
    {
      label: 'a start skips a closed older run without a workspace',
      arrange: async (dirs: string[]) => checkoutRun(dirs, false),
      expected: gone,
    },
    {
      label: 'a start keeps an open run',
      arrange: (dirs: string[]) => workspaceRun(dirs, 'worktree', (state) => state),
      expected: kept,
    },
    {
      label: 'a start keeps a ready-to-apply run',
      arrange: (dirs: string[]) =>
        workspaceRun(dirs, 'worktree', (state) => ({
          ...state,
          phase: 'complete',
          reviewStatus: 'passed',
        })),
      expected: kept,
    },
  ])('$label', { timeout: 60_000 }, async ({ arrange, expected }) => {
    const dirs: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { projectDir, workspaceDir } = await arrange(dirs);
      stderrSpy.mockClear();

      await setupWorkflow({ project: projectDir, fullscreen: false });

      const git = (args: string[]) =>
        execFileSync('git', args, { cwd: projectDir, encoding: 'utf8' });
      expect({
        workspace: workspaceDir !== null && existsSync(workspaceDir),
        worktrees:
          git(['worktree', 'list', '--porcelain'])
            .split('\n')
            .filter((line) => line.startsWith('worktree ')).length - 1,
        record: (await readWorkspaceRecord({ projectDir, sessionId: runId })) !== null,
        stderr: stderrSpy.mock.calls.map((call) => String(call[0])).join(''),
      }).toEqual(expected);
    } finally {
      stderrSpy.mockRestore();
      for (const dir of dirs) cleanupTempDir(dir);
    }
  });

  const editedKeep = 'export const one = 1;\nexport const two = 22;\n';
  const foreignNotice = (path: string) =>
    `The run workspace at ${path} belongs to another project folder and stays on disk. Delete that run workspace when you no longer need it.\n`;

  function moveProject(dirs: string[], projectDir: string): string {
    const movedDir = `${projectDir}-moved`;
    renameSync(projectDir, movedDir);
    dirs.push(movedDir);
    return movedDir;
  }

  async function copiedSessionRun(dirs: string[], strategy: 'worktree' | 'staged-copy') {
    const run = await workspaceRun(dirs, strategy, close);
    const projectDir = realpathSync(createTempDir('setup-copied-session'));
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    ensureSessionDir(projectDir, runId);
    cpSync(sessionDir(run.projectDir, runId), sessionDir(projectDir, runId), { recursive: true });
    return {
      projectDir,
      workspaceDir: run.workspaceDir,
      gitDir: run.projectDir,
      keptAt: run.workspaceDir,
      visible: true,
    };
  }

  it.each([
    {
      label: 'a moved project keeps its worktree on disk and names it on the first start only',
      arrange: async (dirs: string[]) => {
        const run = await workspaceRun(dirs, 'worktree', close);
        const projectDir = moveProject(dirs, run.projectDir);
        const workspaceDir = run.workspaceDir;
        return {
          projectDir,
          workspaceDir,
          gitDir: projectDir,
          keptAt: workspaceDir,
          visible: true,
        };
      },
    },
    {
      label: 'a moved project whose worktree is gone clears its record silently',
      arrange: async (dirs: string[]) => {
        const run = await workspaceRun(dirs, 'worktree', close);
        const projectDir = moveProject(dirs, run.projectDir);
        rmSync(run.workspaceDir, { recursive: true, force: true });
        const workspaceDir = run.workspaceDir;
        return { projectDir, workspaceDir, gitDir: projectDir, keptAt: null, visible: false };
      },
    },
    {
      label: 'a moved project keeps the staged copy it carried and clears its record silently',
      arrange: async (dirs: string[]) => {
        const run = await workspaceRun(dirs, 'staged-copy', close);
        const projectDir = moveProject(dirs, run.projectDir);
        const keptAt = join(projectDir, relative(run.projectDir, run.workspaceDir));
        const workspaceDir = run.workspaceDir;
        return { projectDir, workspaceDir, gitDir: projectDir, keptAt, visible: false };
      },
    },
    {
      label:
        'a moved project keeps the .trees worktree and the splitbrief branch of an older version run',
      arrange: async (dirs: string[]) => {
        const run = await startWorkspaceRun({ strategy: 'worktree', sessionId: runId, dirs });
        const treesPath = join(run.ref.projectDir, '.trees', runId);
        execFileSync('git', ['worktree', 'add', '-b', `splitbrief/${runId}`, treesPath], {
          cwd: run.ref.projectDir,
        });
        writeFileSync(join(treesPath, 'src/keep.ts'), editedKeep);
        saveState(
          run.ref,
          close({
            ...run.state,
            ...(run.state.workspace && { workspace: { ...run.state.workspace, path: treesPath } }),
          }),
        );
        const projectDir = moveProject(dirs, run.ref.projectDir);
        const keptAt = join(projectDir, '.trees', runId);
        return { projectDir, workspaceDir: treesPath, gitDir: projectDir, keptAt, visible: false };
      },
    },
    {
      label: 'a session folder copied into another project keeps the worktree of its first project',
      arrange: (dirs: string[]) => copiedSessionRun(dirs, 'worktree'),
    },
    {
      label:
        'a session folder copied into another project whose first worktree is gone clears its record silently',
      arrange: async (dirs: string[]) => {
        const run = await copiedSessionRun(dirs, 'worktree');
        rmSync(run.workspaceDir, { recursive: true, force: true });
        return { ...run, keptAt: null, visible: false };
      },
    },
    {
      label:
        'a moved project keeps the staged copy that an older End run left with no patch and clears its record silently',
      arrange: async (dirs: string[]) => {
        const run = await startWorkspaceRun({ strategy: 'staged-copy', sessionId: runId, dirs });
        const projectDir = moveProject(dirs, run.ref.projectDir);
        saveState({ projectDir, sessionId: runId }, close(run.state));
        const keptAt = join(projectDir, relative(run.ref.projectDir, run.workspaceDir));
        return {
          projectDir,
          workspaceDir: run.workspaceDir,
          gitDir: projectDir,
          keptAt,
          visible: false,
        };
      },
    },
    {
      label:
        'a session folder copied into another project keeps the staged copy of its first project',
      arrange: (dirs: string[]) => copiedSessionRun(dirs, 'staged-copy'),
    },
  ])('$label', { timeout: 60_000 }, async ({ arrange }) => {
    const dirs: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { projectDir, workspaceDir, gitDir, keptAt, visible } = await arrange(dirs);
      const git = (args: string[]) => execFileSync('git', args, { cwd: gitDir, encoding: 'utf8' });
      const gitLists = () => ({
        worktrees: git(['worktree', 'list', '--porcelain']),
        branches: git(['branch', '--list']),
      });
      const before = gitLists();
      const stderr = () => {
        const text = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
        stderrSpy.mockClear();
        return text;
      };
      stderr();

      await setupWorkflow({ project: projectDir, fullscreen: false });
      const first = {
        record: await readWorkspaceRecord({ projectDir, sessionId: runId }),
        stderr: stderr(),
      };
      await setupWorkflow({ project: projectDir, fullscreen: false });

      expect({
        first,
        second: stderr(),
        edits: keptAt === null ? null : readFileSync(join(keptAt, 'src/keep.ts'), 'utf8'),
        git: gitLists(),
      }).toEqual({
        first: { record: null, stderr: visible ? foreignNotice(workspaceDir) : '' },
        second: '',
        edits: keptAt === null ? null : editedKeep,
        git: before,
      });
    } finally {
      stderrSpy.mockRestore();
      for (const dir of dirs) cleanupTempDir(dir);
    }
  });
});

describe('setupWorkflow render input flags', () => {
  const originalStdoutIsTty = process.stdout.isTTY;
  const originalCi = process.env['CI'];

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutIsTty,
      configurable: true,
    });
    if (originalCi === undefined) delete process.env['CI'];
    else process.env['CI'] = originalCi;
  });

  it.each([
    {
      label: 'TTY defaults',
      tty: true,
      ci: false,
      opts: {} as const,
      expected: { useFullscreen: true, useMouse: true, useHover: false },
    },
    {
      label: 'TTY hover true',
      tty: true,
      ci: false,
      opts: { hover: true } as const,
      expected: { useFullscreen: true, useMouse: true, useHover: true },
    },
    {
      label: 'TTY fullscreen false with hover true',
      tty: true,
      ci: false,
      opts: { fullscreen: false, hover: true } as const,
      expected: { useFullscreen: false, useMouse: false, useHover: false },
    },
    {
      label: 'TTY mouse false with hover true',
      tty: true,
      ci: false,
      opts: { mouse: false, hover: true } as const,
      expected: { useFullscreen: true, useMouse: false, useHover: false },
    },
    {
      label: 'non-TTY',
      tty: false,
      ci: false,
      opts: {} as const,
      expected: { useFullscreen: false, useMouse: false, useHover: false },
    },
    {
      label: 'TTY with CI=1',
      tty: true,
      ci: true,
      opts: {} as const,
      expected: { useFullscreen: false, useMouse: false, useHover: false },
    },
  ])('$label → fullscreen/mouse/hover', async ({ tty, ci, opts, expected }) => {
    Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
    if (ci) process.env['CI'] = '1';
    else delete process.env['CI'];
    createTestGitRepo(tmp);

    const result = await setupWorkflow({ project: tmp, planner: 'claude-code', ...opts });

    expect(result.useFullscreen).toBe(expected.useFullscreen);
    expect(result.useMouse).toBe(expected.useMouse);
    expect(result.useHover).toBe(expected.useHover);
  });
});

describe('canonicalizeProjectDir', () => {
  it('does NOT warn when --project points at the repo root through a symlinked path component', async () => {
    const real = realpathSync(tmp);
    createTestGitRepo(real);
    const link = join(dirname(real), `${tmp.split('/').pop()}-link`);
    symlinkSync(real, link, 'dir');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      // The symlink resolves to the repo root, so this is an exact-root
      // invocation, not a subdirectory — no relocation warning must print.
      const result = await canonicalizeProjectDir({ project: link });

      expect(result).toBe(real);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      cleanupTempDir(link);
    }
  });

  it('warns and relocates to the toplevel when --project is a real subdirectory', async () => {
    const real = realpathSync(tmp);
    createTestGitRepo(real);
    const subdir = join(real, 'pkg');
    mkdirSync(subdir, { recursive: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const result = await canonicalizeProjectDir({ project: subdir });

      expect(result).toBe(real);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('relocates a subdirectory cwd to the toplevel without a warning when no --project is given', async () => {
    const real = realpathSync(tmp);
    createTestGitRepo(real);
    const subdir = join(real, 'packages', 'web');
    mkdirSync(subdir, { recursive: true });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const previousCwd = process.cwd();

    try {
      process.chdir(subdir);

      const result = await canonicalizeProjectDir({});

      // `cd packages/web && splitbrief status` is the ordinary case, not a
      // mistake worth a warning — the commands simply have to agree on
      // which directory the project is.
      expect(result).toBe(real);
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      stderrSpy.mockRestore();
    }
  });

  it('formats toErrorMessage project-relative with a subdirectory cwd and with --project pointing at a subdirectory', async () => {
    const real = realpathSync(tmp);
    createTestGitRepo(real);
    const subdir = join(real, 'packages', 'web');
    mkdirSync(subdir, { recursive: true });
    const target = join(real, 'packages', 'web', 'file.ts');
    const err = Object.assign(new Error(`EACCES: permission denied, open '${target}'`), {
      code: 'EACCES',
      path: target,
    });
    const previousCwd = process.cwd();

    try {
      process.chdir(subdir);
      await canonicalizeProjectDir({});
      expect(toErrorMessage(err)).toBe(`permission denied · ${join('packages', 'web', 'file.ts')}`);
    } finally {
      process.chdir(previousCwd);
    }

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await canonicalizeProjectDir({ project: subdir });
      expect(toErrorMessage(err)).toBe(`permission denied · ${join('packages', 'web', 'file.ts')}`);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('formats toErrorMessage project-relative in a folder that is not a git repository', async () => {
    const real = realpathSync(tmp);
    const link = join(dirname(real), `${tmp.split('/').pop()}-plain-link`);
    symlinkSync(real, link, 'dir');
    const target = join(real, SPLITBRIEF_DIR, CONFIG_FILE);
    const err = Object.assign(new Error(`EACCES: permission denied, open '${target}'`), {
      code: 'EACCES',
      path: target,
    });
    const expected = `permission denied · ${join(SPLITBRIEF_DIR, CONFIG_FILE)}`;
    const previousCwd = process.cwd();

    try {
      process.chdir(real);
      expect(await canonicalizeProjectDir({})).toBe(real);
      expect(toErrorMessage(err)).toBe(expected);
      process.chdir(dirname(real));
      expect(await canonicalizeProjectDir({ project: real.split('/').pop() })).toBe(real);
      expect(toErrorMessage(err)).toBe(expected);
      process.chdir(previousCwd);
      expect(await canonicalizeProjectDir({ project: real })).toBe(real);
      expect(toErrorMessage(err)).toBe(expected);
      expect(await canonicalizeProjectDir({ project: link })).toBe(real);
      expect(toErrorMessage(err)).toBe(expected);
    } finally {
      process.chdir(previousCwd);
      cleanupTempDir(link);
    }
  });
});

describe('assertInteractiveTty', () => {
  afterEach(() => {
    delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  it('throws a CLI error carrying the calling command remedy when stdin is not a TTY', () => {
    delete (process.stdin as { isTTY?: boolean }).isTTY;

    let captured: unknown;
    try {
      assertInteractiveTty('use --json');
      throw new Error('expected assertInteractiveTty to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode?: number }).exitCode).toBe(1);
    expect((captured as Error).message).toBe('interactive mode needs a TTY — use --json');
  });

  it('returns without throwing when stdin is a TTY', () => {
    process.stdin.isTTY = true;
    expect(() => assertInteractiveTty('use --json')).not.toThrow();
  });
});

describe('loadConfigOrExit', () => {
  it('maps config load failures to CLI exit code 1', () => {
    mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
    writeFileSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE), 'planner: [unterminated\n');

    let captured: unknown;
    try {
      loadConfigOrExit(tmp);
      throw new Error('expected loadConfigOrExit to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode?: number }).exitCode).toBe(1);
  });
});
