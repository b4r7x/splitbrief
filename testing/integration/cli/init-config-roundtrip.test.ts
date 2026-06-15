import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import '#testing/helpers/cli/ink-mocks.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import {
  configPath,
  loadConfig,
  writeConfig,
  createDefaultConfig,
} from '../../../src/core/config/load/io.js';

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
  delete (process.stdin as { isTTY?: boolean }).isTTY;
});

describe('CLI integration: init config roundtrip', { timeout: 30_000 }, () => {
  it('writes a default config that loadConfig reads back to the same shape', () => {
    writeConfig(tmp, createDefaultConfig());

    expect(existsSync(configPath(tmp))).toBe(true);

    const { config, warnings } = loadConfig(tmp);
    expect(warnings).toEqual([]);
    expect(config).toEqual(createDefaultConfig());
  });

  it('defers the config write: init without a TTY fails fast and writes nothing', async () => {
    delete (process.stdin as { isTTY?: boolean }).isTTY;

    const { exitCode, stderr } = await runCommand(['init']);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/interactive mode needs a TTY/);
    expect(existsSync(configPath(tmp))).toBe(false);
  });
});
