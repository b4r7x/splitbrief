import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeSessionLockfile } from '#testing/helpers/factories/session-lockfile.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { writeConfig } from '../../../src/core/config/load/io.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import {
  activeFile,
  LOCKFILE,
  sessionDir,
  sessionsRoot,
  STATE_FILE,
} from '../../../src/core/paths.js';

let tmp: string;

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-start-guard');
  createTestGitRepo(tmp);
});

afterEach(() => {
  cleanupTempDir(tmp);
  vi.restoreAllMocks();
});

describe('CLI integration: start beside a live session', () => {
  it('reports the preparation failure of a second launch and preserves the live run', async () => {
    const existingId = '2026-04-18-live';
    const sessDir = sessionDir(tmp, existingId);
    mkdirSync(sessDir, { recursive: true });
    saveState(
      { projectDir: tmp, sessionId: existingId },
      {
        ...createInitialState('first'),
        phase: 'implementing',
        tasks: [],
        currentTaskIndex: 0,
      },
    );
    const active = activeFile(tmp);
    writeFileSync(active, `${existingId}\n`);
    const lockfile = join(sessDir, LOCKFILE);
    writeFileSync(
      lockfile,
      JSON.stringify(
        makeSessionLockfile(existingId, {
          feature: 'first',
          lastAliveMs: Date.now(),
        }),
      ),
    );

    const localRunner = { kind: 'shell' as const, command: './runner', model: 'fixture' };
    writeFileSync(join(tmp, 'runner'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeConfig(tmp, makeConfig({ planner: localRunner, implementer: localRunner }));
    const stateFile = join(sessDir, STATE_FILE);
    const before = { lock: readFileSync(lockfile), state: readFileSync(stateFile) };
    const writeError = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const runHeadless = vi.fn();

    const { exitCode } = await runCommand(
      ['start', '--plain', '--project', tmp, 'another feature'],
      {
        runHeadless,
      },
    );

    expect(exitCode).toBe(1);
    const stderr = writeError.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(stderr).toContain('Configured command is outside the current trust policy.');
    expect(stderr).not.toContain(`Run ${existingId} is still running.`);
    expect(runHeadless).not.toHaveBeenCalled();
    expect(readFileSync(active, 'utf8')).toBe(`${existingId}\n`);
    expect(readFileSync(lockfile)).toEqual(before.lock);
    expect(readFileSync(stateFile)).toEqual(before.state);
    expect(readdirSync(sessionsRoot(tmp))).toEqual([existingId]);
  });
});
