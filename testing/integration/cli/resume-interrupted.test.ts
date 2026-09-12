import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import '#testing/helpers/cli/ink-mocks.js';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createDefaultConfig } from '../../../src/core/config/load/defaults.js';
import { defaultCliAuthChannel } from '../../../src/core/runners/cli-tool-catalog.js';
import { toYaml } from '../../../src/core/config/load/transform.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState, loadState } from '../../../src/core/state/persistence.js';
import { writeLockfile } from '../../../src/core/sessions/lockfile.js';
import { SPLITBRIEF_DIR, CONFIG_FILE, sessionDir } from '../../../src/core/paths.js';

// Resume runs the same readiness gate as start, and the default config points the
// implementer at a local Ollama. The shared no-claim mock keeps the verdict off
// whatever daemon this machine happens to be running.
vi.mock('../../../src/engine/runners/probe-availability.js', () => ({
  probeRunnerAvailability: async (
    ...args: Parameters<
      typeof import('../../../src/engine/runners/probe-availability.js').probeRunnerAvailability
    >
  ) => (await import('#testing/helpers/start-command.js')).probeRunnerAvailabilityMock(...args),
}));

let tmp: string;
let shimDir: string;
let restoreCompatibleCliShim: (() => void) | undefined;

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-resume-interrupted');
  shimDir = createTempDir('cli-resume-interrupted-shim');
  createTestGitRepo(tmp);
  const splitbriefDir = join(tmp, SPLITBRIEF_DIR);
  mkdirSync(splitbriefDir, { recursive: true });
  writeFileSync(
    join(splitbriefDir, CONFIG_FILE),
    YAML.stringify(toYaml(createDefaultConfig())),
    'utf-8',
  );
  // Resume runs the same readiness gate as start. Without a shim the result
  // depends on whether the developer's own machine happens to satisfy the
  // default planner's credentials.
  restoreCompatibleCliShim = activateCompatibleCliShim(
    installCompatibleCliShim({
      directory: shimDir,
      tool: 'claude-code',
      authChannel: defaultCliAuthChannel('claude-code').id,
    }),
    'test-only-resume-interrupted-key',
  );
});

afterEach(() => {
  restoreCompatibleCliShim?.();
  restoreCompatibleCliShim = undefined;
  cleanupTempDir(shimDir);
  cleanupTempDir(tmp);
});

describe('CLI integration: resume interrupted session', { timeout: 90_000 }, () => {
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
    saveState({ projectDir: tmp, sessionId }, state);
    writeFileSync(join(tmp, SPLITBRIEF_DIR, 'active'), sessionId + '\n');

    const { exitCode, stdout } = await runCommand(['resume', '--project', tmp]);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Resuming/);
    expect(stdout).toContain('resume me');
    expect(stdout).toContain('implementing');
    expect(stdout).toContain('2/2');
  });

  it('refuses to start a second workflow when a live process is already running the session', async () => {
    const sessionId = '2026-04-18-already-live';
    const sessDir = sessionDir(tmp, sessionId);
    mkdirSync(sessDir, { recursive: true });
    const state = {
      ...createInitialState('already live'),
      phase: 'implementing' as const,
      tasks: [
        makeTask({ id: 'T001', status: 'done' }),
        makeTask({ id: 'T002', status: 'in_progress', file: 'src/two.ts' }),
      ],
      currentTaskIndex: 1,
    };
    saveState({ projectDir: tmp, sessionId }, state);
    writeFileSync(join(tmp, SPLITBRIEF_DIR, 'active'), sessionId + '\n');

    // A live lockfile: this process's pid + a fresh heartbeat → checkSessionLiveness reports
    // alive. startTimeMs must match the test runner's real ps start time (within
    // checkSessionLiveness's 2s tolerance) so isProcessAliveByPid recognises this pid as the
    // running session.
    const { execFileSync } = await import('node:child_process');
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)])
      .toString()
      .trim();
    const startTimeMs = Date.parse(lstart);
    await writeLockfile(sessDir, {
      pid: process.pid,
      startTimeMs,
      lastAliveMs: Date.now(),
      sessionId,
      mode: 'standard',
      feature: 'already live',
    });

    const { exitCode, stderr, stdout } = await runCommand(['resume', '--project', tmp]);

    // resume must refuse (it does NOT re-enter resumeSavedSession and double-execute).
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/is running/);
    expect(stderr).toMatch(/attach|continue/);
    expect(stdout).not.toMatch(/Resuming/);
    // The saved state is left untouched — no second run gutted or advanced it.
    expect(loadState({ projectDir: tmp, sessionId })).toMatchObject({
      phase: 'implementing',
      currentTaskIndex: 1,
    });
  });
});
