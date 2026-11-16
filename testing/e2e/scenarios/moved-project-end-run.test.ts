import { existsSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionDir } from '../../../src/core/paths.js';
import { readActive } from '../../../src/core/sessions/active-pointer.js';
import { readRunEvents } from '../../../src/engine/events/replay.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  cli,
  continueRun,
  createStopContinueFixture,
  endImplementerHold,
  escapingImplementerScript,
  readState,
  startAndSignal,
  type StopContinueFixture,
} from '../helpers/stop-continue-fixture.js';
import { transcriptText } from '../helpers/transcript-text.js';

const STARTED_IN = 'This run started in';

let fixture: StopContinueFixture | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (fixture !== undefined) {
    await endImplementerHold(fixture);
    cleanupTempDir(fixture.tmpDir);
  }
  fixture = undefined;
});

describe('a run continued from a moved project folder', { timeout: 240_000 }, () => {
  it.each([
    ['a run', 'worktree'],
    ['an in-place run', 'none'],
  ] as const)(
    'says what to do when %s is continued after the project folder moved',
    async (_run, isolation) => {
      fixture = createStopContinueFixture(undefined, { isolation });
      const target = fixture;

      const parked = await startAndSignal(
        target,
        'SIGINT',
        isolation === 'none' ? target.projectDir : target.isolationTreesDir,
      );
      expect(parked.exitCode).toBe(130);
      await endImplementerHold(target);
      const startedIn = realpathSync(target.projectDir);
      const moved = { ...target, projectDir: join(target.tmpDir, 'moved-project') };
      renameSync(target.projectDir, moved.projectDir);

      const resumed = await continueRun(moved);
      expect(resumed.exitCode, resumed.stderr).toBe(1);

      const sentence = `${STARTED_IN} ${startedIn}. Move the project back to that folder to continue the run, or end the run.`;
      const output = `${resumed.stdout}\n${resumed.stderr}`;
      expect(output).toContain(sentence);
      expect(output.split(STARTED_IN)).toHaveLength(2);
      const { events } = await readRunEvents({
        projectDir: moved.projectDir,
        sessionId: parked.sessionId,
      });
      const errors = events.filter((event) => event.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ message: sentence });
      const resumeIndex = events.findLastIndex((event) => event.type === 'workflow_resumed');
      expect(resumeIndex).toBeGreaterThanOrEqual(0);
      // The live-event gate drops every event after the earlier cancellation, so the transcript renders the continuation only.
      const transcript = transcriptText(events.slice(resumeIndex));
      expect(transcript.split(STARTED_IN)).toHaveLength(2);
      for (const text of [transcript, resumed.stdout, resumed.stderr]) {
        expect(text).not.toContain('could not be verified');
        expect(text).not.toContain('is gone or replaced');
      }

      renameSync(moved.projectDir, target.projectDir);
      const finished = await continueRun(target);
      expect(finished.exitCode, finished.stderr).toBe(0);
      expect(readState(target, parked.sessionId).tasks.map((task) => task.status)).toEqual([
        'done',
      ]);
    },
  );

  it('says what to do when Try again answers the halt of an in-place run after the project folder moved', async () => {
    fixture = createStopContinueFixture(escapingImplementerScript, { isolation: 'none' });
    const target = fixture;

    const halted = await cli(target, ['start', 'smoke']);
    expect(halted.exitCode, halted.stderr).toBe(1);
    const sessionId = readActive(target.projectDir);
    if (sessionId === null) throw new Error(`the halted run left no session: ${halted.stderr}`);
    expect(readState(target, sessionId).pendingRecovery?.reason).toBe('checkout-changed');
    const startedIn = realpathSync(target.projectDir);
    const moved = { ...target, projectDir: join(target.tmpDir, 'moved-project') };
    renameSync(target.projectDir, moved.projectDir);

    const retried = await cli(moved, ['continue', sessionId, '--action', 'retry']);

    expect(retried.exitCode, retried.stderr).toBe(1);
    expect(retried.stderr).toContain(
      `${STARTED_IN} ${startedIn}. Move the project back to that folder to continue the run, or end the run.`,
    );
    expect(retried.stderr).not.toContain('no such file or directory');
    expect(retried.stderr).not.toContain('is gone or replaced');
  });

  it('ends a worktree run after the project folder moved, and the next start shows no warning', async () => {
    fixture = createStopContinueFixture(undefined, { isolation: 'worktree' });
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', target.isolationTreesDir);
    expect(parked.exitCode).toBe(130);
    await endImplementerHold(target);

    const parkedState = readState(target, parked.sessionId);
    const workspace = parkedState.workspace;
    if (workspace === undefined) throw new Error('the parked run has no workspace');
    const oldWorktreePath = workspace.path;
    expect(existsSync(oldWorktreePath)).toBe(true);

    const moved = { ...target, projectDir: join(target.tmpDir, 'moved-project') };
    renameSync(target.projectDir, moved.projectDir);

    const ended = await cli(moved, ['continue', parked.sessionId, '--action', 'end-run']);
    expect(ended.exitCode, ended.stderr).toBe(0);

    const output = `${ended.stdout}\n${ended.stderr}`;
    expect(output).not.toContain('could not be verified');
    expect(output).not.toContain('git status');

    const { events } = await readRunEvents({
      projectDir: moved.projectDir,
      sessionId: parked.sessionId,
    });
    const infoEvents = events.filter((event) => event.type === 'info');
    expect(
      infoEvents.filter((event) => event.message?.includes('belongs to another project folder')),
    ).toHaveLength(1);

    vi.stubEnv('SPLITBRIEF_DEBUG', '1');
    await cli(moved, ['start', 'smoke']);
    const debugLog = readFileSync(
      join(moved.projectDir, '.splitbrief', 'logs', 'debug.log'),
      'utf8',
    );
    expect(
      debugLog.split('\n').filter((line) => line.includes('Could not remove the run workspace')),
    ).toEqual([]);
    expect(existsSync(oldWorktreePath)).toBe(true);
  });

  it('ends a staged-copy run after the project folder moved and saves its changes in the run patch', async () => {
    fixture = createStopContinueFixture(undefined, { isolation: 'staged-copy' });
    const target = fixture;

    const parked = await startAndSignal(target, 'SIGINT', target.projectDir);
    expect(parked.exitCode).toBe(130);
    await endImplementerHold(target);

    const moved = { ...target, projectDir: join(target.tmpDir, 'moved-project') };
    renameSync(target.projectDir, moved.projectDir);

    const ended = await cli(moved, ['continue', parked.sessionId, '--action', 'end-run']);
    expect(ended.exitCode, ended.stderr).toBe(0);

    const output = `${ended.stdout}\n${ended.stderr}`;
    expect(output).not.toContain('is gone; no run patch was written');

    const patchPath = join(sessionDir(moved.projectDir, parked.sessionId), 'run.patch');
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, 'utf8')).toContain('RUN_MARKER');
  });
});
