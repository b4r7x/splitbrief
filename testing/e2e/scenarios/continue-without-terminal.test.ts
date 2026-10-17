import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPLITBRIEF_DIR, sessionDir } from '../../../src/core/paths.js';
import { createInitialState } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import {
  createStopContinueFixture,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

const SESSION_ID = 'halted-without-terminal';
const REFUSAL = 'interactive mode needs a TTY — use --json or --plain';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('continue and resume without a terminal', () => {
  it('refuse the TUI with the start message and exit 1, and leave the halted run as it was', async () => {
    fixture = createStopContinueFixture(() => '', { isolation: 'none' });
    const target = fixture;
    saveState(
      { projectDir: target.projectDir, sessionId: SESSION_ID },
      {
        ...createInitialState('Halted run'),
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001' })],
        pendingRecovery: makeRecoveryIssue({}),
      },
    );
    writeFileSync(join(target.projectDir, SPLITBRIEF_DIR, 'active'), `${SESSION_ID}\n`);
    const statePath = join(sessionDir(target.projectDir, SESSION_ID), 'state.json');
    const before = readFileSync(statePath, 'utf8');

    for (const command of [
      ['continue', SESSION_ID, '--action', 'retry'],
      ['continue', SESSION_ID],
      ['resume'],
    ]) {
      // Piped stdio: the child has no terminal, as in a script or a CI job.
      const result = await spawnCli({
        args: ['--import', 'tsx', 'src/cli.ts', ...command, '--project', target.projectDir],
        stateHome: target.stateHome,
        timeoutMs: 60_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.exitCode, output).toBe(1);
      expect(result.stderr).toContain(REFUSAL);
      expect(output).not.toContain('Raw mode');
      expect(output).not.toMatch(/^\s+at /m);
    }
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });
});
