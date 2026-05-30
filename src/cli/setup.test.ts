import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { loadConfigOrExit, setupWorkflow } from './setup.js';
import { DIPTYCH_DIR, CONFIG_FILE } from '../core/paths.js';
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

  it('creates a default config and signals needsSetup when no config exists and no runner overrides are passed', async () => {
    createTestGitRepo(tmp);

    const result = await setupWorkflow({ project: tmp, fullscreen: false });

    expect(result.needsSetup).toBe(true);
    // Real side effect: the default config file now exists on disk.
    expect(existsSync(join(tmp, DIPTYCH_DIR, CONFIG_FILE))).toBe(true);
  });

  it.each([
    { label: 'planner', opts: { planner: 'claude-code' } },
    { label: 'implementer', opts: { implementer: 'ollama' } },
  ] as const)('writes the config without requesting setup when a $label override is provided', async ({
    opts,
  }) => {
    createTestGitRepo(tmp);

    const result = await setupWorkflow({ project: tmp, fullscreen: false, ...opts });

    expect(result.needsSetup).toBeUndefined();
    expect(existsSync(join(tmp, DIPTYCH_DIR, CONFIG_FILE))).toBe(true);
  });

  it('still requests setup when non-runner flags (mode / auto / budget) are the only extras', async () => {
    createTestGitRepo(tmp);

    const mode = await setupWorkflow({ project: tmp, fullscreen: false, mode: 'quick' });
    expect(mode.needsSetup).toBe(true);
  });

  it('does NOT request setup when a config already exists on disk', async () => {
    createTestGitRepo(tmp);
    // Seed the default config.
    const first = await setupWorkflow({ project: tmp, fullscreen: false });
    expect(first.needsSetup).toBe(true);

    // Second invocation: config exists -> no setup prompt.
    const second = await setupWorkflow({ project: tmp, fullscreen: false });
    expect(second.needsSetup).toBeUndefined();
  });
});

describe('loadConfigOrExit', () => {
  it('maps config load failures to CLI exit code 1', () => {
    mkdirSync(join(tmp, DIPTYCH_DIR), { recursive: true });
    writeFileSync(join(tmp, DIPTYCH_DIR, CONFIG_FILE), 'planner: [unterminated\n');

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
