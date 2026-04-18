// Integration complement to src/cli/commands/start.test.ts:44 ('start command — concurrency guard').
// That test asserts the guard in isolation against the command handler; this asserts
// the same guard through `runCommand()` to cover commander wiring, shared subcommand
// registration, and the exit-code contract end-to-end. Intentional duplication — do not collapse.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { runCommand } from '#testing/helpers/commander.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { DIPTYCH_DIR, STATE_FILE } from '../../../src/core/paths.js';

let tmp: string;

beforeEach(() => {
  resetAllStores();
  tmp = createTempDir('cli-start-guard');
  createTestGitRepo(tmp);
});

afterEach(() => {
  cleanupTempDir(tmp);
});

describe('CLI integration: start with a live session', () => {
  it('exits non-zero, preserves the live marker, and does not create a new session', async () => {
    const existingId = '2026-04-18-live';
    const sessionDir = join(tmp, DIPTYCH_DIR, 'sessions', existingId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, STATE_FILE),
      JSON.stringify({ feature: 'first', phase: 'implementing', tasks: [], currentTaskIndex: 0 }),
    );
    writeFileSync(join(tmp, DIPTYCH_DIR, 'active'), existingId + '\n');

    const { exitCode, stderr } = await runCommand(['start', '--project', tmp, 'another feature']);

    expect(exitCode).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
    expect(readFileSync(join(tmp, DIPTYCH_DIR, 'active'), 'utf-8').trim()).toBe(existingId);
    const sessionsRoot = join(tmp, DIPTYCH_DIR, 'sessions');
    const otherSessions = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : [];
    expect(otherSessions).toEqual([existingId]);
  });
});
