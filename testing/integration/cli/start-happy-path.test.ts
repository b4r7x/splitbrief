import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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
  tmp = createTempDir('cli-start-happy');
  createTestGitRepo(tmp);
  const diptychDir = join(tmp, DIPTYCH_DIR);
  mkdirSync(diptychDir, { recursive: true });
  writeFileSync(join(diptychDir, CONFIG_FILE), YAML.stringify(toYaml(createDefaultConfig())), 'utf-8');
});

afterEach(() => {
  cleanupTempDir(tmp);
});

describe('CLI integration: start happy path', () => {
  it('creates a session directory and active marker when starting a new workflow', async () => {
    const { exitCode } = await runCommand(['start', '--project', tmp, 'add endpoint']);

    expect(exitCode).toBe(0);
    const sessionsRoot = join(tmp, DIPTYCH_DIR, 'sessions');
    const ids = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : [];
    expect(ids).toHaveLength(1);
    const [sessionId] = ids;
    if (!sessionId) throw new Error('session id missing');
    expect(sessionId).toMatch(/add-endpoint/);
    expect(readFileSync(join(tmp, DIPTYCH_DIR, 'active'), 'utf-8').trim()).toBe(sessionId);
  }, 20_000);
});
