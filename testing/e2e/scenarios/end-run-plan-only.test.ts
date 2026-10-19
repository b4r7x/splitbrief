import { afterEach, describe, expect, it } from 'vitest';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('End run on a run that only planned', { timeout: 120_000 }, () => {
  it('closes the run without saying it wrote files', async () => {
    // Every planner call fails, so the run halts in planning before any brief starts.
    fixture = createStopContinueFixture(undefined, { consult: () => '() => process.exit(1)' });
    const target = fixture;

    const started = await cli(target, ['start', 'smoke']);
    const sessionId = readActive(target.projectDir);
    if (sessionId === null)
      throw new Error(`the halted run left no active session: ${started.stderr}`);
    const halted = readState(target, sessionId);
    expect(halted.pendingRecovery, started.stderr).toBeDefined();
    expect(halted.workspace).toBeUndefined();
    expect(halted.tasks.every((task) => task.status === 'pending')).toBe(true);

    const ended = await cli(target, ['continue', sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    expect(readState(target, sessionId).closed?.as).toBe('ended');
    expect(ended.stdout).toBe(`Run ${sessionId} closed.\n`);
  });
});
