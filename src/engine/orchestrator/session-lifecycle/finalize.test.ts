import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { buildRetryExhaustedRecoveryIssue } from '../recovery/builders/task.js';
import {
  readActive,
  readActiveRecord,
  reactivateExistingSession,
  type ActiveSessionReceipt,
} from '../../../core/sessions/active-pointer.js';
import { randomUUID } from 'node:crypto';
import { activeFile, sessionDir } from '../../../core/paths.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { Session } from '../../../core/schemas/session.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { saveFinalSession, shouldPreserveActiveState } from './finalize.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function makeProjectDir(): string {
  const projectDir = createTempDir('session-lifecycle-test');
  dirs.push(projectDir);
  return projectDir;
}

function makeSummary(): Summary {
  return {
    feature: 'recoverable feature',
    totalTasks: 1,
    completedByLocal: 0,
    escalatedToPlanner: 0,
    skipped: 0,
    failed: 0,
    totalTime: 10,
    tokenUsage: makeUsage(),
    escalationRate: 0,
  };
}

function receipt(sessionId: string): ActiveSessionReceipt {
  return { version: 1, sessionId, generation: randomUUID() };
}

function persisted(projectDir: string, sessionId: string): Session {
  const raw = readFileSync(join(sessionDir(projectDir, sessionId), 'summary.json'), 'utf-8');
  return JSON.parse(raw) as Session;
}

function completedState(): WorkflowState {
  return { ...createInitialState('feat'), phase: 'complete', reviewStatus: 'passed' };
}

describe('saveFinalSession', () => {
  it('records a run that passed its review as complete and clears the active session', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-final';
    const active = reactivateExistingSession({ projectDir, sessionId });

    saveFinalSession({
      projectDir,
      sessionId,
      active,
      feature: 'final feature',
      startTime: 1,
      summary: makeSummary(),
      state: completedState(),
    });

    expect(persisted(projectDir, sessionId).status).toBe('complete');
    expect(existsSync(activeFile(projectDir))).toBe(false);
  });

  it('records an open run with its stop reason and keeps the active session', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-recovery';
    const active = reactivateExistingSession({ projectDir, sessionId });

    saveFinalSession({
      projectDir,
      sessionId,
      active,
      feature: 'recoverable feature',
      startTime: 1,
      summary: makeSummary(),
      state: { ...createInitialState('feat'), phase: 'implementing' },
    });

    expect(persisted(projectDir, sessionId)).toMatchObject({
      status: 'open',
      stop: 'interrupted',
      phase: 'implementing',
    });
    expect(readActive(projectDir)).toBe(sessionId);
  });

  it('records the failure a run left on its state', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-failed';

    saveFinalSession({
      projectDir,
      sessionId,
      active: receipt(sessionId),
      feature: 'f',
      startTime: 1,
      summary: makeSummary(),
      state: {
        ...createInitialState('feat'),
        phase: 'idle',
        lastFailure: {
          step: { kind: 'planner', call: 'research' },
          message: 'Planning failed.',
          at: '2026-09-01T00:00:00.000Z',
        },
      },
    });

    expect(persisted(projectDir, sessionId)).toMatchObject({ status: 'open', stop: 'failed' });
  });

  it('records a run with no tracked state as open and interrupted', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-no-state';

    saveFinalSession({
      projectDir,
      sessionId,
      active: receipt(sessionId),
      feature: 'f',
      startTime: 1,
      summary: makeSummary(),
      state: undefined,
    });

    expect(persisted(projectDir, sessionId)).toMatchObject({ status: 'open', stop: 'interrupted' });
  });

  it('writes a summary.json that carries no stateFile key', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-no-statefile';

    saveFinalSession({
      projectDir,
      sessionId,
      active: receipt(sessionId),
      feature: 'f',
      startTime: 1,
      summary: makeSummary(),
      state: completedState(),
    });

    expect('stateFile' in persisted(projectDir, sessionId)).toBe(false);
  });

  it('does not clear a pointer the active session no longer owns (compare-and-clear)', () => {
    const projectDir = makeProjectDir();
    const other = reactivateExistingSession({ projectDir, sessionId: 'sess-other' });

    saveFinalSession({
      projectDir,
      sessionId: 'sess-final',
      active: receipt('sess-final'),
      feature: 'f',
      startTime: 1,
      summary: makeSummary(),
      state: completedState(),
    });

    expect(readActive(projectDir)).toBe('sess-other');
    expect(readActiveRecord(projectDir)).toEqual({ kind: 'v1', receipt: other });
  });

  it('resume and finalization use an exact active receipt while a newer same-session generation survives', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-resume-generation';
    const ref = { projectDir, sessionId };
    const stale = reactivateExistingSession(ref);
    const newer = reactivateExistingSession(ref);

    saveFinalSession({
      projectDir,
      sessionId,
      active: stale,
      feature: 'resumed feature',
      startTime: 1,
      summary: makeSummary(),
      state: completedState(),
    });

    expect(readActiveRecord(projectDir)).toEqual({ kind: 'v1', receipt: newer });
  });
});

describe('shouldPreserveActiveState', () => {
  it('clears when there is no loaded state', () => {
    expect(shouldPreserveActiveState(null)).toBe(false);
    expect(shouldPreserveActiveState(undefined)).toBe(false);
  });

  it('preserves a pending recovery even when the phase looks terminal', () => {
    const issue = buildRetryExhaustedRecoveryIssue({
      task: makeTask({ id: 'T001' }),
      validationSummary: 'tsc failed',
      attempts: 1,
      maxAttempts: 2,
      createdAt: '2026-04-29T00:00:00.000Z',
    });
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'complete',
      pendingRecovery: issue,
    };
    expect(shouldPreserveActiveState(state)).toBe(true);
  });

  it('preserves awaiting-continue state', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      awaitingContinue: true,
    };
    expect(shouldPreserveActiveState(state)).toBe(true);
  });

  it.each(['planning', 'reviewing-briefs', 'implementing', 'final-review', 'analyzing'] as const)(
    'preserves an open run saved at %s',
    (phase) => {
      const state: WorkflowState = { ...createInitialState('feat'), phase };
      expect(shouldPreserveActiveState(state)).toBe(true);
    },
  );

  it('clears a run that passed its review', () => {
    expect(shouldPreserveActiveState(completedState())).toBe(false);
  });

  it('clears a run the user explicitly ended', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      closed: { at: '2026-09-01T00:00:00.000Z', as: 'ended' },
    };
    expect(shouldPreserveActiveState(state)).toBe(false);
  });
});
