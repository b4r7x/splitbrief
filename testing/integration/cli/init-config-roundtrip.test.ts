import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { configPath, loadConfig, createDefaultConfig } from '../../../src/core/config/load/load.js';

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, render: () => ({ waitUntilExit: async () => {}, unmount: () => {}, clear: () => {}, rerender: () => {}, cleanup: () => {} }) };
});
vi.mock('fullscreen-ink', () => ({
  withFullScreen: () => ({ start: async () => {}, waitUntilExit: async () => {} }),
}));

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-init-roundtrip');
  createTestGitRepo(tmp);
  prevCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(prevCwd);
  cleanupTempDir(tmp);
});

describe('CLI integration: init config roundtrip', () => {
  it('writes a default .diptych/config.yaml that loadConfig can read back to the same shape', async () => {
    const { exitCode } = await runCommand(['init']);

    expect(exitCode).toBe(0);
    expect(existsSync(configPath(tmp))).toBe(true);

    const { config, warnings } = loadConfig(tmp);
    expect(warnings).toEqual([]);
    expect(config).toEqual(createDefaultConfig());
  });
});
