import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '#testing/helpers/cli/ink-mocks.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { writeConfigYaml } from '#testing/helpers/config-io.js';
import { createDefaultConfig } from '../../../src/core/config/load/defaults.js';
import { toYaml } from '../../../src/core/config/load/transform.js';

let tmp: string;

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-exit-codes');
  createTestGitRepo(tmp);
  process.stdin.isTTY = true;
});

afterEach(() => {
  cleanupTempDir(tmp);
  delete (process.stdin as { isTTY?: boolean }).isTTY;
});

function writeValidConfig(projectDir: string): void {
  writeConfigYaml(projectDir, toYaml(createDefaultConfig()));
}

function writeInvalidConfig(projectDir: string): void {
  writeConfigYaml(projectDir, { version: 3, implementer: { kind: 'bogus', model: '' } });
}

describe('CLI exit codes', { timeout: 90_000 }, () => {
  it('start with invalid config exits 1', async () => {
    writeInvalidConfig(tmp);

    const { exitCode, stderr } = await runCommand(['start', '--project', tmp, 'add endpoint']);

    expect(exitCode).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('continue with no sessions exits 1', async () => {
    writeValidConfig(tmp);

    const { exitCode, stderr } = await runCommand(['continue', '--project', tmp]);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/no session to continue/);
  });
});
