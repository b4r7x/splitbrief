import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  failedReviewVerdict,
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { readRunRecord } from '../../../core/sessions/run-record-io.js';
import { readSession } from '../../../core/sessions/io.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { EngineEvent } from '../../events/types.js';
import { readRunEvents } from '../../events/replay.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../events/workflow-cancel.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import { closeRunIfOpen } from './close.js';
import { runTrackedWorkflow, settleTrackedWorkflows } from '#testing/helpers/tracked-workflow.js';

const race = vi.hoisted(() => ({ writePassedAfterRead: false, writeOpenAfterRead: false }));
vi.mock('../state-ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state-ops.js')>();
  return {
    ...actual,
    rebaseOnPersistedWorkflowState: (
      ...args: Parameters<typeof actual.rebaseOnPersistedWorkflowState>
    ) => {
      const latest = actual.rebaseOnPersistedWorkflowState(...args);
      if (race.writePassedAfterRead && latest.phase === 'final-review') {
        race.writePassedAfterRead = false;
        actual.transitionAndSave(args[0], latest, { type: 'REVIEW_DONE', reviewStatus: 'passed' });
      }
      if (
        race.writeOpenAfterRead &&
        latest.phase === 'complete' &&
        latest.reviewStatus === 'failed'
      ) {
        race.writeOpenAfterRead = false;
        actual.transitionAndSave(args[0], latest, {
          type: 'MARK_RECOVERY_APPLYING',
          action: 'revise',
        });
      }
      return latest;
    },
  };
});

const dirs: string[] = [];
afterEach(async () => {
  await settleTrackedWorkflows();
  race.writePassedAfterRead = false;
  race.writeOpenAfterRead = false;
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function preparedFinalReview(ref: SessionRef, state: WorkflowState) {
  return makePreparedExecution({
    ...ref,
    feature: state.feature,
    resumeState: state,
    active: reactivateExistingSession(ref),
    config: makeConfig({
      validation: { endChecks: false, testCommand: 'noop' },
      planner: {
        kind: 'shell',
        command: process.execPath,
        args: ['-e', ''],
        outputFormat: 'text',
      },
      implementer: {
        kind: 'shell',
        model: 'fixture',
        command: process.execPath,
        args: ['-e', ''],
        outputFormat: 'text',
      },
    }),
  });
}

describe('workflow closure', () => {
  it('retries End run after a newer open failed-review state is saved', async () => {
    const projectDir = createTempDir('workflow-closure-open-race-');
    dirs.push(projectDir);
    const ref = { projectDir, sessionId: 'failed-review-closure-race' };
    ensureSessionDir(projectDir, ref.sessionId);
    const state: WorkflowState = {
      ...createInitialState('Failed review closure race'),
      phase: 'complete',
      reviewStatus: 'failed',
      pendingRecovery: buildReviewFailedRecoveryIssue({
        blocking: 1,
        phase: 'complete',
        createdAt: new Date('2026-05-01T10:00:00Z').toISOString(),
      }),
    };
    saveState(ref, state);
    race.writeOpenAfterRead = true;
    const closure = await closeRunIfOpen(ref, state);
    expect(race.writeOpenAfterRead).toBe(false);
    expect(closure.closedNow).toBe(true);
    expect(closure.state.stateRevision).toBe(2);
    expect(closure.state.pendingRecovery).toBeUndefined();
    expect(closure.state.reviewStatus).toBe('failed');
    expect(readRunRecord(ref)?.status).toEqual({ kind: 'closed', as: 'ended' });
  });

  it('End run overtaken by a passing review closes the ready run without a patch', async () => {
    const projectDir = createTempDir('workflow-closure-race-');
    dirs.push(projectDir);
    execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
    const ref = { projectDir, sessionId: 'review-closure-race' };
    ensureSessionDir(projectDir, ref.sessionId);
    const state: WorkflowState = {
      ...createInitialState('Review closure race'),
      phase: 'final-review',
      changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
    };
    saveState(ref, state);
    const prepared = preparedFinalReview(ref, state);
    const controller = new AbortController();
    const events: EngineEvent[] = [];
    await runTrackedWorkflow({
      prepared,
      sinks: TEST_SINKS,
      callbacks: makeCallbacks().callbacks,
      signal: controller.signal,
      _planner: makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt) => {
            race.writePassedAfterRead = true;
            controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
            return passingReviewVerdict(prompt);
          },
        ),
      }),
      _implementer: makeImplementer(),
      _eventSink: (event) => events.push(event),
    });
    expect(race.writePassedAfterRead).toBe(false);
    expect(readRunRecord(ref)?.status).toEqual({ kind: 'closed', as: 'discarded' });
    expect(readSession(ref)?.status).toBe('ended');
    expect(loadState(ref)?.reviewStatus).toBe('passed');
    expect(loadState(ref)?.closed?.patch).toBeUndefined();
    expect(existsSync(join(sessionDir(projectDir, ref.sessionId), 'run.patch'))).toBe(false);
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toEqual([]);
    expect(
      (await readRunEvents(ref)).events.filter((event) => event.type === 'workflow_cancelled'),
    ).toEqual([]);
    expect(existsSync(join(projectDir, '.git', 'index'))).toBe(false);
    expect(readdirSync(join(projectDir, '.git', 'objects'))).toEqual(['info', 'pack']);
  });

  it.each([
    { at: 'completion event', review: 'passed' },
    { at: 'completion callback', review: 'passed' },
    { at: 'completion event', review: 'failed' },
  ] as const)(
    'End run at the $at keeps the $review review and closes the run without a patch',
    async ({ at, review }) => {
      const projectDir = createTempDir('workflow-closure-');
      dirs.push(projectDir);
      execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
      const ref = { projectDir, sessionId: 'review-closure' };
      ensureSessionDir(projectDir, ref.sessionId);
      const state: WorkflowState = {
        ...createInitialState('Review closure'),
        phase: 'final-review',
        ...(review === 'failed' && {
          fixCycles: { used: 2, notes: [], open: { cycle: 2 } },
          triage: [
            {
              cycle: 2,
              at: '2026-10-03T00:00:00Z',
              inputIds: [],
              result: {
                fixTasks: [{ ...makeTaskSpec({ id: 'T900' }), findingIds: ['F1'] }],
                rejected: [],
                verify: [],
                ask: null,
              },
              blocking: ['finding:F1'],
              scope: 'final',
            },
          ],
        }),
        changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
      };
      saveState(ref, state);
      const prepared = preparedFinalReview(ref, state);
      const controller = new AbortController();
      const events: EngineEvent[] = [];
      let firstClosure: WorkflowState | null = null;
      const end = () => {
        firstClosure = loadState(ref);
        controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
      };
      await runTrackedWorkflow({
        prepared,
        sinks: TEST_SINKS,
        callbacks: makeCallbacks({
          onComplete: () => {
            if (at === 'completion callback') end();
          },
        }).callbacks,
        signal: controller.signal,
        _planner: makePlanner({
          typedCall: typedCallPlanAndReview(
            () => planFromTasks([]),
            (prompt) =>
              review === 'passed'
                ? passingReviewVerdict(prompt)
                : failedReviewVerdict(prompt, 'the closure fixture fails the review'),
          ),
        }),
        _implementer: makeImplementer(),
        _eventSink: (event) => {
          events.push(event);
          if (at === 'completion event' && event.type === 'workflow_complete') end();
        },
      });
      expect(events.filter((event) => event.type === 'workflow_complete')).toMatchObject([
        { review },
      ]);
      expect(firstClosure).not.toBeNull();
      const saved = loadState(ref);
      const closedAs = review === 'passed' ? 'discarded' : 'ended';
      expect(saved?.closed?.as).toBe(closedAs);
      expect(saved?.reviewStatus).toBe(review);
      expect(saved?.pendingRecovery).toBeUndefined();
      expect(readRunRecord(ref)?.status).toEqual({ kind: 'closed', as: closedAs });
      expect(saved?.closed?.patch).toBeUndefined();
      expect(existsSync(join(sessionDir(projectDir, ref.sessionId), 'run.patch'))).toBe(false);
      // End run on the ready run is its Discard: only the failed review had a run left to stop.
      const stops = closedAs === 'ended' ? 1 : 0;
      expect(events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(stops);
      expect(
        (await readRunEvents(ref)).events.filter((event) => event.type === 'workflow_cancelled'),
      ).toHaveLength(stops);
      expect(existsSync(join(projectDir, '.git', 'index'))).toBe(false);
      expect(readdirSync(join(projectDir, '.git', 'objects'))).toEqual(['info', 'pack']);
    },
  );

  it('a signal that arrives once the review passed leaves the run ready with no stop', async () => {
    const projectDir = createTempDir('workflow-closure-signal-');
    dirs.push(projectDir);
    execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
    const ref = { projectDir, sessionId: 'review-closure-signal' };
    ensureSessionDir(projectDir, ref.sessionId);
    const state: WorkflowState = {
      ...createInitialState('Review closure signal'),
      phase: 'final-review',
      changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
    };
    saveState(ref, state);
    const events: EngineEvent[] = [];
    await runTrackedWorkflow({
      prepared: preparedFinalReview(ref, state),
      sinks: TEST_SINKS,
      callbacks: makeCallbacks().callbacks,
      _planner: makePlanner({
        typedCall: typedCallPlanAndReview(
          () => planFromTasks([]),
          (prompt) => passingReviewVerdict(prompt),
        ),
      }),
      _implementer: makeImplementer(),
      _eventSink: (event) => {
        events.push(event);
        if (event.type === 'workflow_complete') process.emit('SIGINT');
      },
    });
    const saved = loadState(ref);
    if (saved === null) throw new Error('the run saved no state');
    expect(deriveRunStatus({ state: saved, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toEqual([]);
    expect(
      (await readRunEvents(ref)).events.filter((event) => event.type === 'workflow_cancelled'),
    ).toEqual([]);
  });
});
