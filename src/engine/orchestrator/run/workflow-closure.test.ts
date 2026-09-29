import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { reactivateExistingSession } from '../../../core/sessions/active-pointer.js';
import { readRunRecord } from '../../../core/sessions/run-record-io.js';
import { readSession } from '../../../core/sessions/io.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent } from '../../events/types.js';
import { readRunEvents } from '../../events/replay.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../events/workflow-cancel.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import { closeRunIfOpen } from './close.js';
import { runWorkflow } from './workflow.js';

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
        actual.transitionAndSave(args[0], latest, { type: 'PAUSE_PENDING_RECOVERY' });
      }
      return latest;
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  race.writePassedAfterRead = false;
  race.writeOpenAfterRead = false;
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('workflow closure', () => {
  it('retries End run after a newer open failed-review state is saved', () => {
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
    const closure = closeRunIfOpen(ref, state);
    expect(race.writeOpenAfterRead).toBe(false);
    expect(closure.closedNow).toBe(true);
    expect(closure.state.stateRevision).toBe(2);
    expect(closure.state.pendingRecovery).toBeUndefined();
    expect(closure.state.reviewStatus).toBe('failed');
    expect(readRunRecord(ref)?.status).toEqual({ kind: 'closed', as: 'ended' });
  });

  it('keeps a passed closure written after End run reads an open state', async () => {
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
    const prepared = makePreparedExecution({
      ...ref,
      feature: state.feature,
      resumeState: state,
      active: reactivateExistingSession(ref),
      config: makeConfig({
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
    const controller = new AbortController();
    const events: EngineEvent[] = [];
    await runWorkflow({
      prepared,
      sinks: TEST_SINKS,
      callbacks: makeCallbacks().callbacks,
      signal: controller.signal,
      _planner: makePlanner({
        review: async () => {
          race.writePassedAfterRead = true;
          controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
          return { text: '### Verdict\npass\n', usage: null };
        },
      }),
      _implementer: makeImplementer(),
      _eventSink: (event) => events.push(event),
    });
    expect(race.writePassedAfterRead).toBe(false);
    expect(readRunRecord(ref)?.status).toEqual({ kind: 'closed', as: 'complete' });
    expect(readSession(ref)?.status).toBe('complete');
    expect(readSession(ref)?.summary?.phase).toBe('complete');
    expect(loadState(ref)?.reviewStatus).toBe('passed');
    expect(events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(0);
    expect(
      (await readRunEvents(ref)).events.filter((event) => event.type === 'workflow_cancelled'),
    ).toHaveLength(0);
    expect(existsSync(join(projectDir, '.git', 'index'))).toBe(false);
    expect(readdirSync(join(projectDir, '.git', 'objects'))).toEqual(['info', 'pack']);
  });

  it.each([
    { at: 'completion event', review: 'passed' },
    { at: 'completion callback', review: 'passed' },
    { at: 'completion event', review: 'failed' },
  ] as const)(
    'preserves the $review review when End run lands at the $at',
    async ({ at, review }) => {
      const projectDir = createTempDir('workflow-closure-');
      dirs.push(projectDir);
      execFileSync('git', ['init', projectDir], { stdio: 'ignore' });
      const ref = { projectDir, sessionId: 'review-closure' };
      ensureSessionDir(projectDir, ref.sessionId);
      const state: WorkflowState = {
        ...createInitialState('Review closure'),
        phase: 'final-review',
        changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
      };
      saveState(ref, state);
      const prepared = makePreparedExecution({
        ...ref,
        feature: state.feature,
        resumeState: state,
        active: reactivateExistingSession(ref),
        config: makeConfig({
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
      const controller = new AbortController();
      const events: EngineEvent[] = [];
      let firstClosure: WorkflowState | null = null;
      const end = () => {
        firstClosure = loadState(ref);
        controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
      };
      await runWorkflow({
        prepared,
        sinks: TEST_SINKS,
        callbacks: makeCallbacks({
          onComplete: () => {
            if (at === 'completion callback') end();
          },
        }).callbacks,
        signal: controller.signal,
        _planner: makePlanner({
          review: async () => ({
            text: `### Verdict\n${review === 'passed' ? 'pass' : 'fail'}\n`,
            usage: null,
          }),
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
      const passed = review === 'passed';
      const saved = loadState(ref);
      if (passed) expect(saved).toEqual(firstClosure);
      else {
        expect(saved?.closed?.as).toBe('ended');
        expect(saved?.reviewStatus).toBe('failed');
        expect(saved?.pendingRecovery).toBeUndefined();
      }
      expect(readRunRecord(ref)?.status).toEqual({
        kind: 'closed',
        as: passed ? 'complete' : 'ended',
      });
      expect(events.filter((event) => event.type === 'workflow_cancelled')).toHaveLength(
        passed ? 0 : 1,
      );
      expect(
        (await readRunEvents(ref)).events.filter((event) => event.type === 'workflow_cancelled'),
      ).toHaveLength(passed ? 0 : 1);
      expect(existsSync(join(projectDir, '.git', 'index'))).toBe(false);
      expect(readdirSync(join(projectDir, '.git', 'objects'))).toEqual(['info', 'pack']);
    },
  );
});
