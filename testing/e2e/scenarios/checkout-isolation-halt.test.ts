import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  createStopContinueFixture,
  ESCAPED_BRANCH,
  escapingImplementerScript,
  GREET_FILE,
  GREET_SOURCE,
  readState,
  MARKER_FILE,
  MARKER_SOURCE,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('e2e: a checkout whose git state changes during an in-place implementer call', () => {
  it('halts with the evidence, puts the attempt back and retries to a close in the checkout', async () => {
    fixture = createStopContinueFixture(escapingImplementerScript, { isolation: 'none' });

    const halted = await cli(fixture, ['start', 'smoke']);

    expect(halted.exitCode).toBe(1);
    const sessionId = readActive(fixture.projectDir);
    if (sessionId === null) throw new Error(`the halted run left no session: ${halted.stderr}`);
    expect(halted.stderr).toContain(
      `Recovery required (checkout-changed): Your checkout changed under T001 — branch ${ESCAPED_BRANCH}`,
    );
    expect(halted.stderr).toContain(
      `Continue with: splitbrief continue ${sessionId} --action retry`,
    );
    expect(halted.stdout).not.toContain('task T001: done');
    expect(
      execFileSync('git', ['branch', '--list', ESCAPED_BRANCH], {
        cwd: fixture.projectDir,
        encoding: 'utf8',
      }).trim(),
    ).toBe(ESCAPED_BRANCH);

    const haltedState = readState(fixture, sessionId);
    expect(haltedState.pendingRecovery?.reason).toBe('checkout-changed');

    expect(existsSync(fixture.markerPath)).toBe(false);
    expect(existsSync(fixture.greetPath)).toBe(false);
    const reverted = join(sessionDir(fixture.projectDir, sessionId), 'reverted');
    const [stamp, ...otherStamps] = readdirSync(reverted);
    expect(otherStamps).toEqual([]);
    if (stamp === undefined) throw new Error('the halt saved nothing under reverted/');
    expect(readFileSync(join(reverted, stamp, MARKER_FILE), 'utf-8')).toBe(MARKER_SOURCE);
    expect(readFileSync(join(reverted, stamp, GREET_FILE), 'utf-8')).toBe(GREET_SOURCE);

    const continued = await cli(fixture, ['continue', sessionId, '--action', 'retry']);

    expect(continued.exitCode, continued.stderr).toBe(0);
    expect(continued.stdout).toContain('task T001: done');

    const finalState = readState(fixture, sessionId);
    expect(finalState.applied).toBeUndefined();
    expect(deriveRunStatus({ state: finalState, liveness: 'not-alive' })).toEqual({
      kind: 'closed',
      as: 'complete',
    });
    expect(existsSync(join(sessionDir(fixture.projectDir, sessionId), 'run.patch'))).toBe(false);
    expect(readFileSync(fixture.greetPath, 'utf-8')).toBe(GREET_SOURCE);
  }, 150_000);
});
