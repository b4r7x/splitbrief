import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeSessionLockfile } from '#testing/helpers/factories/session-lockfile.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { SPLITBRIEF_DIR, LOCKFILE, sessionDir } from '../../../src/core/paths.js';

let tmp: string;
let stdinWasTty: boolean | undefined;

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-start-guard');
  createTestGitRepo(tmp);
  stdinWasTty = process.stdin.isTTY;
  process.stdin.isTTY = true;
});

afterEach(() => {
  cleanupTempDir(tmp);
  if (stdinWasTty === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
  else process.stdin.isTTY = stdinWasTty;
});

describe('CLI integration: start with a live session', { timeout: 90_000 }, () => {
  it('exits non-zero, preserves the live marker, and does not create a new session', async () => {
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
    writeFileSync(join(tmp, SPLITBRIEF_DIR, 'active'), `${existingId}\n`);
    writeFileSync(
      join(sessDir, LOCKFILE),
      JSON.stringify(
        makeSessionLockfile(existingId, {
          feature: 'first',
          lastAliveMs: Date.now(),
        }),
      ),
    );

    const { exitCode, stderr } = await runCommand(['start', '--project', tmp, 'another feature']);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("session '2026-04-18-live' is still active");
    expect(readFileSync(join(tmp, SPLITBRIEF_DIR, 'active'), 'utf-8').trim()).toBe(existingId);
    const sessionsRoot = join(tmp, SPLITBRIEF_DIR, 'sessions');
    const otherSessions = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : [];
    expect(otherSessions).toEqual([existingId]);
  });
});
