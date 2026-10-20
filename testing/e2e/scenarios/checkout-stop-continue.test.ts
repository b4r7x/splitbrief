import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { assertPlainStdout } from '../helpers/run-dir-assertions.js';
import {
  continueRun,
  createStopContinueFixture,
  endImplementerHold,
  GREET_SOURCE,
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
}

function git(target: StopContinueFixture, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: target.projectDir, encoding: 'utf-8' });
}

/** Every directory under the fixture's isolation root: a worktree run leaves one here. */
function worktreeDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '.git') {
      found.push(path, ...worktreeDirs(path));
    }
  }
  return found;
}

describe('e2e: a checkout-mode run stopped by SIGINT and continued in place', () => {
  it('parks the brief mid-step and finishes it in the checkout with no Apply, no worktree and no run.patch', async () => {
    fixture = createStopContinueFixture(undefined, { isolation: 'none' });
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', target.projectDir);
    expect(parked.exitCode).toBe(130);

    const parkedState = readState(target, parked.sessionId);
    expect(parkedState.workspace?.kind).toBe('checkout');
    expect(parkedState.interruptedStep?.cut).toBe('mid-step');
    expect(parkedState.tasks[0]?.status).toBe('in_progress');
    expect(parkedState.pendingRecovery).toBeUndefined();
    // The stopped brief's partial is in the checkout itself; there is no second tree.
    expect(readFileSync(target.markerPath, 'utf-8')).toBe(MARKER_SOURCE);

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    expectFinishedPlainRun(resumed.stdout);
    // The replay found the stopped attempt's partial where it was left: the checkout as it is.
    expect(readFileSync(target.replaySawPartialPath, 'utf-8')).toBe('true');

    const finalState = readState(target, parked.sessionId);
    expect(finalState.tasks[0]?.status).toBe('done');
    expect(finalState.pendingRecovery).toBeUndefined();
    expect(finalState.applied).toBeUndefined();
    expect(deriveRunStatus({ state: finalState, liveness: 'not-alive' })).toEqual({
      kind: 'closed',
      as: 'complete',
    });

    // The checkout holds both of the brief's files, and the run never staged them.
    expect(readFileSync(target.markerPath, 'utf-8')).toBe(MARKER_SOURCE);
    expect(readFileSync(target.greetPath, 'utf-8')).toBe(GREET_SOURCE);
    expect(git(target, ['diff', '--cached', '--name-only']).trim()).toBe('');

    // No run.patch, no isolation worktree, and the only worktree is the checkout.
    expect(existsSync(join(sessionDir(target.projectDir, parked.sessionId), 'run.patch'))).toBe(
      false,
    );
    expect(worktreeDirs(target.isolationTreesDir)).toEqual([]);
    const worktrees = git(target, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('worktree '));
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.slice('worktree '.length)).toBe(realpathSync(target.projectDir));
  }, 240_000);
});
