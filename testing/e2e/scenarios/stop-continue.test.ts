import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATE_FILE, sessionDir } from '../../../src/core/paths.js';
import { readRunnerPids } from '../../../src/core/sessions/runner-pids.js';
import { canSignalProcess } from '../../../src/lib/process/liveness.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import type { EngineEvent, EngineEventOf } from '../../../src/engine/events/types.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { checkoutEntries } from '#testing/helpers/checkout.js';
import { spawnCli } from '../helpers/live-cli-harness.js';
import { assertPlainStdout } from '../helpers/run-dir-assertions.js';
import {
  applyRun,
  continueRun,
  createStopContinueFixture,
  endImplementerHold,
  findMarker,
  GREET_SOURCE,
  MARKER_FILE,
  MARKER_SOURCE,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';

/** The watchdog's SIGTERM-to-SIGKILL grace plus a loaded box's start-up. */
const ORPHAN_EXIT_TIMEOUT_MS = 10_000;

let fixture: StopContinueFixture | undefined;

function cutCalls(events: readonly EngineEvent[]): EngineEventOf<'runner_call_error'>[] {
  return events.filter(
    (event): event is EngineEventOf<'runner_call_error'> =>
      event.type === 'runner_call_error' && event.error.code === 'runner_interrupted',
  );
}

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
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'parks a brief cut by %s, exits %i and continues it to a passing review',
    async (signal, code) => {
      fixture = createStopContinueFixture();
      const target = fixture;
      const checkoutAtStart = checkoutEntries(target.projectDir);

      const parked = await startAndSignal(target, signal, target.isolationTreesDir);
      expect(parked.exitCode, parked.stderr).toBe(code);
      expect(parked.stderr.split('\n')).toContain(
        `Run ${parked.sessionId} stopped. Continue with: splitbrief continue ${parked.sessionId}`,
      );

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
    },
  );

  it('restarts a brief killed by SIGKILL from its task-start snapshot', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const checkoutAtStart = checkoutEntries(target.projectDir);

    const killed = await startAndSignal(target, 'SIGKILL', target.isolationTreesDir);
    expect(killed.exitCode).toBeNull();
    // The kill cuts the CLI before it can release its runner ledger; the implementer it left in
    // its hold ends with it, so the marker stays the attempt's only partial.
    const orphans = readRunnerPids({ projectDir: target.projectDir, sessionId: killed.sessionId });
    expect(orphans, 'the killed run left no runner pid in its ledger').not.toEqual([]);
    for (const { pid } of orphans) {
      await vi.waitFor(
        () => expect(canSignalProcess(pid), `implementer ${pid} outlived the CLI`).toBe(false),
        { timeout: ORPHAN_EXIT_TIMEOUT_MS, interval: 50 },
      );
    }

    expectStoppedWorkInWorkspace(target, checkoutAtStart);

    // The killed process wrote no end for its BUILD call: nothing in the log says it was cut.
    const ref = { projectDir: target.projectDir, sessionId: killed.sessionId };
    expect(cutCalls((await readRunEvents(ref)).events)).toEqual([]);

    const killedState = readState(target, killed.sessionId);
    expect(killedState.interruptedStep).toBeUndefined();
    expect(killedState.tasks[0]?.status).toBe('in_progress');
    expect(killedState.attempt).toBe(0);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expectFinishedPlainRun(resumed.stdout);

    // The continuation released the dead implementer's ledger entry before it ran the brief.
    expect(readRunnerPids({ projectDir: target.projectDir, sessionId: killed.sessionId })).toEqual(
      [],
    );

    // The continuation recorded the cut once, closing the killed call before it ran the brief
    // again: the log now says where the run was interrupted.
    const events = (await readRunEvents(ref)).events;
    const cut = cutCalls(events);
    expect(cut).toHaveLength(1);
    const cutIndex = events.indexOf(cut[0] as EngineEvent);
    const killedCall = events.findLastIndex(
      (event, index) =>
        index < cutIndex &&
        event.type === 'runner_call_started' &&
        event.callId === (cut[0] as EngineEventOf<'runner_call_error'>).callId,
    );
    const resumedAt = events.findIndex((event) => event.type === 'workflow_resumed');
    expect(killedCall).toBeGreaterThanOrEqual(0);
    expect(cutIndex).toBeGreaterThan(killedCall);
    expect(cutIndex).toBeLessThan(resumedAt);

    const finalState = readState(target, killed.sessionId);
    expect(finalState.tasks[0]?.status).toBe('done');
    expect(finalState.attempt).toBe(0);
    expect(finalState.pendingRecovery).toBeUndefined();
    await expectAppliedOnce(target, killed.sessionId, checkoutAtStart);
  });

  it('names the blocker and the flag when a headless continue lacks --allow-repo-runners', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(130);
    const parkedState = readFileSync(
      join(sessionDir(target.projectDir, parked.sessionId), STATE_FILE),
      'utf-8',
    );

    for (const mode of ['--plain', '--json']) {
      const blocked = await spawnCli({
        args: ['--import', 'tsx', 'src/cli.ts', 'continue', mode, '--project', target.projectDir],
        stateHome: target.stateHome,
        timeoutMs: 60_000,
      });
      expect(blocked.exitCode, blocked.stderr).toBe(1);
      expect(blocked.stderr).toContain('Run readiness: blocked');
      expect(blocked.stderr.split('Run readiness: blocked').length).toBe(2);
      expect(blocked.stderr).toContain('BUILD could not start.');
      expect(blocked.stderr).toContain('`splitbrief continue --allow-repo-runners`');
      expect(blocked.stderr).toContain('Resolve the blockers above');
      expect(blocked.stdout).toBe('');
    }
    expect(
      readFileSync(join(sessionDir(target.projectDir, parked.sessionId), STATE_FILE), 'utf-8'),
    ).toBe(parkedState);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expectFinishedPlainRun(resumed.stdout);
  });
});
