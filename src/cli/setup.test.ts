import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  assertInteractiveTty,
  canonicalizeProjectDir,
  loadConfigOrExit,
  setupWorkflow,
} from './setup.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../core/paths.js';
import { isCliError } from './errors.js';

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
    'writes the config without requesting setup when a $label override is provided',
    async ({ opts }) => {
      createTestGitRepo(tmp);

      const result = await setupWorkflow({ project: tmp, fullscreen: false, ...opts });

      expect(result.needsSetup).toBeUndefined();
      expect(existsSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(true);
    },
  );

  it('still requests setup when non-runner flags (mode / auto / budget) are the only extras', async () => {
    createTestGitRepo(tmp);

    const mode = await setupWorkflow({ project: tmp, fullscreen: false, mode: 'quick' });
    expect(mode.needsSetup).toBe(true);
  });

  it('re-requests setup on a second call when the first wizard was abandoned (no config written)', async () => {
    createTestGitRepo(tmp);

    // First call signals setup but writes nothing (wizard never completes).
    const first = await setupWorkflow({ project: tmp, fullscreen: false });
    expect(first.needsSetup).toBe(true);
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);

    // Abandoned wizard -> next start still requests setup, not skips it.
    const second = await setupWorkflow({ project: tmp, fullscreen: false });
    expect(second.needsSetup).toBe(true);
  });

  it('does NOT request setup when a config already exists on disk', async () => {
    createTestGitRepo(tmp);
    // Simulate a completed wizard by passing a runner override (eager write).
    const first = await setupWorkflow({ project: tmp, fullscreen: false, planner: 'claude-code' });
    expect(first.needsSetup).toBeUndefined();
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(true);

    // Second invocation: config exists -> no setup prompt.
    const second = await setupWorkflow({ project: tmp, fullscreen: false });
    expect(second.needsSetup).toBeUndefined();
  });

  it('canonicalizes a repo SUBDIRECTORY to the git toplevel so state is not split per-cwd', async () => {
    createTestGitRepo(tmp);
    const subdir = join(tmp, 'packages', 'web');
    mkdirSync(subdir, { recursive: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A runner override takes the eager-write branch, so we can observe where
    // the config lands relative to the invocation subdir.
    const result = await setupWorkflow({
      project: subdir,
      fullscreen: false,
      planner: 'claude-code',
    });

    // The resolved project root is the repository toplevel, never the subdir.
    expect(result.projectDir).not.toBe(subdir);
    expect(result.projectDir).toBe(realpathSync(tmp));
    // The config landed at the toplevel, not under the invocation subdir.
    expect(existsSync(join(result.projectDir, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(true);
    expect(existsSync(join(subdir, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);
    errorSpy.mockRestore();
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
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // The symlink resolves to the repo root, so this is an exact-root
      // invocation, not a subdirectory — no relocation warning must print.
      const result = await canonicalizeProjectDir({ project: link });

      expect(result).toBe(real);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      cleanupTempDir(link);
    }
  });

  it('warns and relocates to the toplevel when --project is a real subdirectory', async () => {
    const real = realpathSync(tmp);
    createTestGitRepo(real);
    const subdir = join(real, 'pkg');
    mkdirSync(subdir, { recursive: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = await canonicalizeProjectDir({ project: subdir });

      expect(result).toBe(real);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('relocates a subdirectory cwd to the toplevel without a warning when no --project is given', async () => {
    const real = realpathSync(tmp);
    createTestGitRepo(real);
    const subdir = join(real, 'packages', 'web');
    mkdirSync(subdir, { recursive: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousCwd = process.cwd();

    try {
      process.chdir(subdir);

      const result = await canonicalizeProjectDir({});

      // `cd packages/web && splitbrief ps` is the ordinary case, not a
      // mistake worth a warning — the commands simply have to agree on
      // which directory the project is.
      expect(result).toBe(real);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      errorSpy.mockRestore();
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
      assertInteractiveTty('use --json or --detach');
      throw new Error('expected assertInteractiveTty to throw');
    } catch (err) {
      captured = err;
    }

    expect(isCliError(captured)).toBe(true);
    expect((captured as { exitCode?: number }).exitCode).toBe(1);
    expect((captured as Error).message).toBe(
      'interactive mode needs a TTY — use --json or --detach',
    );
  });

  it('returns without throwing when stdin is a TTY', () => {
    process.stdin.isTTY = true;
    expect(() => assertInteractiveTty('use --json or --detach')).not.toThrow();
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
