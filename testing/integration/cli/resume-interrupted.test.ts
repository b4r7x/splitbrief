import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import '#testing/helpers/cli/ink-mocks.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createDefaultConfig } from '../../../src/core/config/load/load.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { DIPTYCH_DIR, CONFIG_FILE, sessionDir } from '../../../src/core/paths.js';

let tmp: string;

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-resume-interrupted');
  createTestGitRepo(tmp);
  const diptychDir = join(tmp, DIPTYCH_DIR);
  mkdirSync(diptychDir, { recursive: true });
  writeFileSync(join(diptychDir, CONFIG_FILE), YAML.stringify(toYaml(createDefaultConfig())), 'utf-8');
});

afterEach(() => {
  cleanupTempDir(tmp);
});

describe('CLI integration: resume interrupted session', () => {
  it('loads the saved state and logs resumption for a mid-implementation session', async () => {
    const sessionId = '2026-04-18-resume-me';
    mkdirSync(sessionDir(tmp, sessionId), { recursive: true });
    const state = {
      ...createInitialState('resume me'),
      phase: 'implementing' as const,
      tasks: [
        makeTask({ id: 'T001', status: 'done' }),
        makeTask({ id: 'T002', status: 'in_progress', file: 'src/two.ts' }),
      ],
      currentTaskIndex: 1,
    };
    saveState(tmp, sessionId, state);
    writeFileSync(join(tmp, DIPTYCH_DIR, 'active'), sessionId + '\n');

    const { exitCode, stdout } = await runCommand(['resume', '--project', tmp]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Resuming/);
    expect(stdout).toContain('resume me');
    expect(stdout).toContain('implementing');
    expect(stdout).toContain('2/2');
  });
});
