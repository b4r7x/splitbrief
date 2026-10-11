import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { checkoutEntries } from '#testing/helpers/checkout.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
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

describe('headless End run', { timeout: 240_000 }, () => {
  it('ends a SIGINT-parked run without pending recovery and preserves its patch', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const checkoutAtStart = checkoutEntries(target.projectDir);
    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(0);
    const parkedState = readState(target, parked.sessionId);
    expect(parkedState.pendingRecovery).toBeUndefined();
    const workspace = parkedState.workspace;
    if (workspace === undefined) throw new Error('the parked run has no workspace');
    expect(workspace.kind).toBe('worktree');
    expect(relative(target.isolationTreesDir, workspace.path)).not.toMatch(/^\.\./);
    expect(existsSync(workspace.path)).toBe(true);

    const ended = await cli(target, ['continue', parked.sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    expect(ended.stdout).toBe(`Run ${parked.sessionId} closed.\n`);
    const closed = readState(target, parked.sessionId).closed;
    expect(closed?.as).toBe('ended');
    if (closed?.patch === undefined) throw new Error('the ended run has no patch');
    const patch = join(target.projectDir, closed.patch);
    expect(patch).toBe(join(sessionDir(target.projectDir, parked.sessionId), 'run.patch'));
    expect(existsSync(patch)).toBe(true);
    expect(readFileSync(patch, 'utf8')).toContain(
      "+export const RUN_MARKER = 'implementer-started';",
    );
    expect(existsSync(workspace.path)).toBe(false);
    expect(checkoutEntries(target.projectDir)).toEqual(checkoutAtStart);
  });

  it('discards a ready run through End run and keeps its files out of the checkout', async () => {
    fixture = createStopContinueFixture();
    const target = fixture;
    const checkoutAtStart = checkoutEntries(target.projectDir);
    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(0);
    expect(readState(target, parked.sessionId).pendingRecovery).toBeUndefined();

    const resumed = await continueRun(target);
    expect(resumed.exitCode, resumed.stderr).toBe(0);
    const ready = readState(target, parked.sessionId);
    expect(deriveRunStatus({ state: ready, liveness: 'not-alive' }).kind).toBe('ready-to-apply');

    const ended = await cli(target, ['continue', parked.sessionId, '--action', 'end-run']);

    expect(ended.exitCode, ended.stderr).toBe(0);
    expect(ended.stdout).toBe(`Run ${parked.sessionId} closed.\n`);
    const closed = readState(target, parked.sessionId).closed;
    expect(closed?.as).toBe('discarded');
    if (closed?.patch === undefined) throw new Error('the discarded run has no patch');
    const patch = join(target.projectDir, closed.patch);
    expect(patch).toBe(join(sessionDir(target.projectDir, parked.sessionId), 'run.patch'));
    expect(existsSync(patch)).toBe(true);
    expect(ended.stderr).toContain('run.patch; apply them with git apply.');
    expect(existsSync(target.markerPath)).toBe(false);
    expect(existsSync(target.greetPath)).toBe(false);
    expect(checkoutEntries(target.projectDir)).toEqual(checkoutAtStart);
  });
});
