import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { checkoutEntries } from '#testing/helpers/checkout.js';
import {
  applyRun,
  cli,
  createStopContinueFixture,
  ESCAPED_BRANCH,
  escapingImplementerScript,
  GREET_SOURCE,
  readState,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(() => {
  if (fixture !== undefined) cleanupTempDir(fixture.tmpDir);
  fixture = undefined;
});

describe('e2e: a checkout whose git state changes during an implementer call', () => {
  it('halts the headless run with the evidence, and continue --action retry finishes it', async () => {
    fixture = createStopContinueFixture(escapingImplementerScript);
    const checkoutAtStart = checkoutEntries(fixture.projectDir);

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
    expect(existsSync(fixture.greetPath)).toBe(false);
    const state = readState(fixture, sessionId);
    expect(state.pendingRecovery?.reason).toBe('checkout-changed');

    const continued = await cli(fixture, ['continue', sessionId, '--action', 'retry']);

    expect(continued.exitCode, continued.stderr).toBe(0);
    expect(continued.stdout).toContain('task T001: done');
    expect(checkoutEntries(fixture.projectDir)).toEqual(checkoutAtStart);

    const applied = await applyRun(fixture, sessionId);

    expect(applied.exitCode, applied.stderr).toBe(0);
    expect(readFileSync(fixture.greetPath, 'utf-8')).toBe(GREET_SOURCE);
  }, 150_000);
});
