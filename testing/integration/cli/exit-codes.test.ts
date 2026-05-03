import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createDefaultConfig } from '../../../src/core/config/load/load.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { DIPTYCH_DIR, CONFIG_FILE } from '../../../src/core/paths.js';

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, render: () => ({ waitUntilExit: async () => {}, unmount: () => {}, clear: () => {}, rerender: () => {}, cleanup: () => {} }) };
});
vi.mock('fullscreen-ink', () => ({
  withFullScreen: () => ({ start: async () => {}, waitUntilExit: async () => {} }),
}));

let tmp: string;

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-exit-codes');
  createTestGitRepo(tmp);
});

afterEach(() => {
  cleanupTempDir(tmp);
});

function writeValidConfig(projectDir: string): void {
  const diptychDir = join(projectDir, DIPTYCH_DIR);
  mkdirSync(diptychDir, { recursive: true });
  writeFileSync(join(diptychDir, CONFIG_FILE), YAML.stringify(toYaml(createDefaultConfig())), 'utf-8');
}

function writeInvalidConfig(projectDir: string): void {
  const diptychDir = join(projectDir, DIPTYCH_DIR);
  mkdirSync(diptychDir, { recursive: true });
  writeFileSync(
    join(diptychDir, CONFIG_FILE),
    YAML.stringify({ version: 3, implementer: { kind: 'bogus', model: '' } }),
    'utf-8',
  );
}

describe('CLI exit codes', () => {
  it('start with valid config exits 0', async () => {
    writeValidConfig(tmp);

    const { exitCode } = await runCommand(['start', '--project', tmp, 'add endpoint']);

    expect(exitCode).toBe(0);
  }, 20_000);

  it('start with invalid config exits 1', async () => {
    writeInvalidConfig(tmp);

    const { exitCode, stderr } = await runCommand(['start', '--project', tmp, 'add endpoint']);

    expect(exitCode).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('continue with no sessions exits 1', async () => {
    writeValidConfig(tmp);

    const { exitCode, stderr } = await runCommand(['continue', '--project', tmp]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/no session to continue/);
  });

  it('last with no sessions exits 1', async () => {
    writeValidConfig(tmp);

    const { exitCode, stderr } = await runCommand(['last', '--project', tmp]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/no sessions found/);
  });

  it('stats with no data exits 0', async () => {
    writeValidConfig(tmp);

    const { exitCode } = await runCommand(['stats', '--project', tmp]);

    expect(exitCode).toBe(0);
  });
});
