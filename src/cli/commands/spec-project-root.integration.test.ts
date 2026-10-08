import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
import { registerSpecCommand } from './spec.js';

let tmp: string;
let subdir: string;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

// Preparation is where readiness probes the configured CLI; stopping there
// keeps this test about where `spec` decides the project lives.
const stopAtPreparation = async () => {
  throw new Error('preparation stopped by test');
};

beforeEach(() => {
  tmp = realpathSync(createTempDir('spec-project-root-test'));
  createTestGitRepo(tmp);
  subdir = join(tmp, 'packages', 'api');
  mkdirSync(subdir, { recursive: true });
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  consoleSpy.mockRestore();
  errorSpy.mockRestore();
});

function runSpec(args: string[]): Promise<unknown> {
  const program = new Command();
  registerSpecCommand(program, { prepareExecution: stopAtPreparation });
  return program.parseAsync(['node', 'splitbrief', 'spec', ...args]).catch(() => undefined);
}

describe('spec command project root', () => {
  it('auto-creates the config at the repository root, never inside a package directory', async () => {
    await runSpec(['--project', subdir, 'add a helper']);

    expect(existsSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(true);
    expect(existsSync(join(subdir, SPLITBRIEF_DIR, CONFIG_FILE))).toBe(false);
  });

  it('leaves no stray .gitignore behind in the package directory', async () => {
    await runSpec(['--project', subdir, 'add a helper']);

    expect(existsSync(join(subdir, '.gitignore'))).toBe(false);
    expect(existsSync(join(tmp, '.gitignore'))).toBe(true);
  });

  it('tells the user the project was relocated to the repository root', async () => {
    await runSpec(['--project', subdir, 'add a helper']);

    const warnings = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warnings.some((line: string) => line.includes('using repository root'))).toBe(true);
  });
});
