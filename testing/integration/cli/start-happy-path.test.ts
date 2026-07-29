import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import '#testing/helpers/cli/ink-mocks.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { createDefaultConfig } from '../../../src/core/config/load/io.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { SPLITBRIEF_DIR, CONFIG_FILE } from '../../../src/core/paths.js';

let tmp: string;

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-start-happy');
  createTestGitRepo(tmp);
  process.stdin.isTTY = true;
  const splitbriefDir = join(tmp, SPLITBRIEF_DIR);
  mkdirSync(splitbriefDir, { recursive: true });
  writeFileSync(
    join(splitbriefDir, CONFIG_FILE),
    YAML.stringify(toYaml(createDefaultConfig())),
    'utf-8',
  );
});

afterEach(() => {
  cleanupTempDir(tmp);
  delete (process.stdin as { isTTY?: boolean }).isTTY;
});

describe('CLI integration: start happy path', { timeout: 90_000 }, () => {
  it('creates a session directory and active marker when starting a new workflow', async () => {
    const { exitCode } = await runCommand(['start', '--project', tmp, 'add endpoint']);

    expect(exitCode).toBe(0);
    const sessionsRoot = join(tmp, SPLITBRIEF_DIR, 'sessions');
    const ids = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : [];
    expect(ids).toHaveLength(1);
    const [sessionId] = ids;
    if (!sessionId) throw new Error('session id missing');
    expect(sessionId).toMatch(/add-endpoint/);
    expect(readFileSync(join(tmp, SPLITBRIEF_DIR, 'active'), 'utf-8').trim()).toBe(sessionId);
  }, 90_000);
});
