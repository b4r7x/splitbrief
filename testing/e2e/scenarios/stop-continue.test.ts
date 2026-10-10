import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { readRunnerPids } from '../../../src/core/sessions/runner-pids.js';
import { canSignalProcess } from '../../../src/lib/process/liveness.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { checkoutEntries } from '#testing/helpers/checkout.js';
import { assertPlainStdout } from '../helpers/run-dir-assertions.js';
import {
  applyRun,
  continueRun,
  createStopContinueFixture,
  endImplementerHold,
  findMarker,
  GREET_FILE,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

let fixture: StopContinueFixture | undefined;

afterEach(async () => {
  if (fixture !== undefined) {
    // Confirm the held implementer is gone (or take it down) before its release file's
    // directory is removed: deleting first would race the child's 50 ms poll.
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
});

function expectFinishedPlainRun(stdout: string): void {
  assertPlainStdout(stdout);
  const lines = stdout.split('\n').map((line) => line.trim());
  expect(lines).toContain('task T001: done (no checks)');
  expect(lines).toContain('done: 1 tasks');
}

function expectStoppedWorkInWorkspace(
  target: StopContinueFixture,
  checkoutAtStart: Record<string, string>,
): void {
  const marker = findMarker(target.isolationTreesDir);
  if (marker === null) throw new Error(`no ${MARKER_FILE} left in the run workspace`);
  expect(readFileSync(marker, 'utf-8')).toBe(MARKER_SOURCE);
  expect(checkoutEntries(target.projectDir)).toEqual(checkoutAtStart);
}

/**
 * The finished run waits for Apply with the checkout as it started; Apply then
 * writes the brief's two files into it.
 */
async function expectAppliedOnce(
  target: StopContinueFixture,
  sessionId: string,
  checkoutAtStart: Record<string, string>,
): Promise<void> {
  expect(checkoutEntries(target.projectDir)).toEqual(checkoutAtStart);

  const applied = await applyRun(target, sessionId);
  expect(applied.exitCode, applied.stderr).toBe(0);
  expect(applied.stderr).toContain('Applied 2 files to your checkout.');

  expect(readState(target, sessionId).closed?.as).toBe('applied');
  expect(readFileSync(target.markerPath, 'utf-8')).toBe(MARKER_SOURCE);
  expect(readFileSync(target.greetPath, 'utf-8')).toBe(GREET_SOURCE);
}

describe('stop → continue → finish', { timeout: 240_000 }, () => {
  it('parks a brief cut by SIGINT and continues it to a passing review', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const checkoutAtStart = checkoutEntries(target.projectDir);

    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(0);

    const parkedState = readState(target, parked.sessionId);
    expect(parkedState.interruptedStep?.cut).toBe('mid-step');
    expect(parkedState.tasks[0]?.status).toBe('in_progress');
    expect(parkedState.pendingRecovery).toBeUndefined();
    const parkedAttempt = parkedState.attempt;
    // The stopped brief keeps its partial in the run workspace; the checkout never saw it.
    expectStoppedWorkInWorkspace(target, checkoutAtStart);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expectFinishedPlainRun(resumed.stdout);

    const finalState = readState(target, parked.sessionId);
    expect(finalState.tasks[0]?.status).toBe('done');
    expect(finalState.attempt).toBe(parkedAttempt);
    expect(finalState.pendingRecovery).toBeUndefined();

    await expectAppliedOnce(target, parked.sessionId, checkoutAtStart);
  });

  it('restarts a brief killed by SIGKILL from its task-start snapshot', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const checkoutAtStart = checkoutEntries(target.projectDir);

    const killed = await startAndSignal(target, 'SIGKILL', target.isolationTreesDir);
    expect(killed.exitCode).toBeNull();
    // The kill cuts the CLI, not the implementer: the first attempt stays in its hold, holding
    // the marker as its only partial, until the continuation's boot reaps it. The test reaps
    // nothing itself — the continuation owning that cleanup is what this case exercises.
    const orphans = readRunnerPids({ projectDir: target.projectDir, sessionId: killed.sessionId });
    expect(orphans, 'the killed run left no runner pid in its ledger to reap').not.toEqual([]);
    for (const { pid } of orphans) {
      expect(
        canSignalProcess(pid),
        `implementer ${pid} died before the continuation could reap it`,
      ).toBe(true);
    }

    expectStoppedWorkInWorkspace(target, checkoutAtStart);

    const killedState = readState(target, killed.sessionId);
    expect(killedState.interruptedStep).toBeUndefined();
    expect(killedState.tasks[0]?.status).toBe('in_progress');
    expect(killedState.attempt).toBe(0);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expectFinishedPlainRun(resumed.stdout);

    // The continuation reaped the orphan and released its ledger entry before it ran the brief.
    for (const { pid } of orphans) {
      expect(
        canSignalProcess(pid),
        `implementer ${pid} outlived the continuation's reap, so it can still write ${GREET_FILE} into the worktree`,
      ).toBe(false);
    }
    expect(readRunnerPids({ projectDir: target.projectDir, sessionId: killed.sessionId })).toEqual(
      [],
    );

    const finalState = readState(target, killed.sessionId);
    expect(finalState.tasks[0]?.status).toBe('done');
    expect(finalState.attempt).toBe(0);
    expect(finalState.pendingRecovery).toBeUndefined();
    await expectAppliedOnce(target, killed.sessionId, checkoutAtStart);
  });
});
