import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApplyRun, withApplyRun } from '#testing/helpers/apply-run.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { readRunRecord } from '../../../core/sessions/run-record-io.js';
import { saveState } from '../../../core/state/persistence.js';
import * as stagedProject from '../approval/staged-project.js';
import { activeApply, awaitActiveWorkflowShutdown } from '../session-lifecycle/shutdown.js';
import { runApplyAtRest } from './at-rest.js';
import * as backup from './backup.js';

vi.mock('../approval/staged-project.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../approval/staged-project.js')>();
  return { ...actual, promoteStagedChanges: vi.fn(actual.promoteStagedChanges) };
});
vi.mock('./backup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./backup.js')>();
  return { ...actual, writeApplyBackup: vi.fn(actual.writeApplyBackup) };
});

const SESSION_ID = '2026-10-18-apply-at-rest-test';

/** Holds one Apply step at its entry until released, then runs the real step. */
function holdStep<A extends unknown[], R>(
  mocked: { mockImplementation: (fn: (...args: A) => Promise<R>) => unknown },
  actual: (...args: A) => Promise<R>,
) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  mocked.mockImplementation(async (...args: A) => {
    entered.resolve();
    await release.promise;
    return actual(...args);
  });
  return { entered: entered.promise, release: () => release.resolve() };
}

function applyAtRest(run: ApplyRun) {
  const state = makeWorkflowState({
    phase: 'complete',
    reviewStatus: 'passed',
    workspace: run.workspace,
  });
  saveState({ projectDir: run.dir, sessionId: run.sessionId }, state);
  return () =>
    runApplyAtRest({
      wctx: { projectDir: run.dir, sessionId: run.sessionId, bus: makeBusRecorder().bus },
      state,
      config: createDefaultConfig(),
    });
}

const actualStaged = await vi.importActual<typeof import('../approval/staged-project.js')>(
  '../approval/staged-project.js',
);
const actualBackup = await vi.importActual<typeof import('./backup.js')>('./backup.js');

beforeEach(() => {
  vi.mocked(stagedProject.promoteStagedChanges)
    .mockReset()
    .mockImplementation(actualStaged.promoteStagedChanges);
  vi.mocked(backup.writeApplyBackup).mockReset().mockImplementation(actualBackup.writeApplyBackup);
});

describe('runApplyAtRest', { timeout: 60_000 }, () => {
  it('holds the run while its Apply writes: running, awaited by shutdown, refused a second time', async () => {
    await withApplyRun(
      { 'a.txt': 'one\n' },
      { sessionId: SESSION_ID, strategy: 'staged-copy' },
      async (run) => {
        writeFileSync(join(run.ws, 'new.txt'), 'created\n');
        const ref = { projectDir: run.dir, sessionId: run.sessionId };
        const backupStep = holdStep(
          vi.mocked(backup.writeApplyBackup),
          actualBackup.writeApplyBackup,
        );
        const promoteStep = holdStep(
          vi.mocked(stagedProject.promoteStagedChanges),
          actualStaged.promoteStagedChanges,
        );
        const start = applyAtRest(run);

        const applying = start();
        await backupStep.entered;
        expect(readRunRecord(ref).status).toEqual({ kind: 'running' });

        backupStep.release();
        await promoteStep.entered;
        expect(readRunRecord(ref).status).toEqual({ kind: 'running' });

        let shutDown = false;
        const shutdown = awaitActiveWorkflowShutdown().then(() => {
          shutDown = true;
        });
        await expect(start()).rejects.toMatchObject({ kind: 'workflow-session-already-live' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(shutDown).toBe(false);
        expect(activeApply()).toBeDefined();

        promoteStep.release();
        expect((await applying).outcome).toBe('applied');
        await shutdown;
        expect(activeApply()).toBeUndefined();
        expect(readRunRecord(ref).status).toEqual({ kind: 'closed', as: 'applied' });
      },
    );
  });

  it('closes the applied run with the time it ran and the time of each stage', async () => {
    await withApplyRun(
      { 'a.txt': 'one\n' },
      { sessionId: SESSION_ID, strategy: 'staged-copy' },
      async (run) => {
        writeFileSync(join(run.ws, 'a.txt'), 'two\n');
        const start = applyAtRest(run);
        const log = [
          ['workflow_started', '2026-10-19T10:00:00.000Z', 'planning'],
          ['task_started', '2026-10-19T10:01:00.000Z', 'implementing'],
          ['review_started', '2026-10-19T10:03:00.000Z', 'final-review'],
          ['workflow_complete', '2026-10-19T10:03:30.000Z', 'complete'],
        ].map(([type, ts, phase]) => JSON.stringify({ kind: 'event', ts, type, phase, data: {} }));
        writeFileSync(join(sessionDir(run.dir, run.sessionId), SESSION_LOG_FILE), log.join('\n'));

        expect((await start()).outcome).toBe('applied');

        const record = readRunRecord({ projectDir: run.dir, sessionId: run.sessionId });
        expect(record.status).toEqual({ kind: 'closed', as: 'applied' });
        expect(record.summary).toMatchObject({
          activeTime: 210_000,
          phaseTimings: { planning: 60_000, implementing: 120_000, review: 30_000 },
        });
      },
    );
  });
});
