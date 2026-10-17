import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  continueRun,
  createStopContinueFixture,
  endImplementerHold,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(async () => {
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
});

describe('a worktree run over a large uncommitted file', { timeout: 240_000 }, () => {
  it('reaches BUILD, stops, and continues to a passing review', async () => {
    fixture = createStopContinueFixture(undefined, { isolation: 'worktree' });
    const target = fixture;
    // More than the 8 MiB the workspace continuation record may hold.
    const large = Buffer.alloc(9 * 1024 * 1024, 'x');
    writeFileSync(join(target.projectDir, 'large.bin'), large);

    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(0);
    const parkedState = readState(target, parked.sessionId);
    expect(parkedState.workspace?.kind).toBe('worktree');
    expect(parkedState.interruptedStep?.cut).toBe('mid-step');
    expect(parkedState.pendingRecovery).toBeUndefined();
    const record = join(sessionDir(target.projectDir, parked.sessionId), 'retained-workspace.json');
    expect(statSync(record).size).toBeLessThan(1024 * 1024);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expect(resumed.stderr).not.toContain('continuation record');
    const finalState = readState(target, parked.sessionId);
    expect(finalState.tasks[0]?.status).toBe('done');
    expect(finalState.pendingRecovery).toBeUndefined();
    expect(readFileSync(join(target.projectDir, 'large.bin')).equals(large)).toBe(true);
  });
});
