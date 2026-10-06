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
import {
  finalizeEndedRun,
  finalizeRunAtRest,
  reopenSessionRecord,
  saveFinalSession,
  shouldPreserveActiveState,
} from './finalize.js';
import { readSession } from '../../../core/sessions/io.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
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
      stop: 'stopped',
      phase: 'implementing',
    });
    expect(readActive(projectDir)).toBe(sessionId);
  });

  it('records a run that left a failure on its state as stopped', () => {
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

    expect(persisted(projectDir, sessionId)).toMatchObject({ status: 'open', stop: 'stopped' });
  });

  it('records a run with no tracked state as open and stopped', () => {
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

    expect(persisted(projectDir, sessionId)).toMatchObject({ status: 'open', stop: 'stopped' });
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

describe('reopenSessionRecord', () => {
  function haltedState(): WorkflowState {
    return {
      ...createInitialState('feat'),
      phase: 'implementing',
      pendingRecovery: buildRetryExhaustedRecoveryIssue({
        task: makeTask({ id: 'T001' }),
        validationSummary: 'tsc failed',
        attempts: 1,
        maxAttempts: 2,
        createdAt: '2026-04-29T00:00:00.000Z',
      }),
    };
  }

  it('drops the stop the last pass recorded and keeps the rest of the record', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-reopened';
    saveFinalSession({
      projectDir,
      sessionId,
      feature: 'halted feature',
      startTime: 1,
      summary: makeSummary(),
      state: haltedState(),
    });
    expect(persisted(projectDir, sessionId).stop).toBe('waiting-for-you');

    reopenSessionRecord({ projectDir, sessionId });

    const reopened = persisted(projectDir, sessionId);
    expect(reopened.stop).toBeUndefined();
    expect(reopened).toMatchObject({ id: sessionId, status: 'open', summary: makeSummary() });
  });

  it('leaves a closed record and a missing one as they are', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-closed';
    saveFinalSession({
      projectDir,
      sessionId,
      feature: 'final feature',
      startTime: 1,
      summary: makeSummary(),
      state: completedState(),
    });
    const before = persisted(projectDir, sessionId);

    reopenSessionRecord({ projectDir, sessionId });
    reopenSessionRecord({ projectDir, sessionId: 'sess-never-ran' });

    expect(persisted(projectDir, sessionId)).toEqual(before);
    expect(existsSync(join(sessionDir(projectDir, 'sess-never-ran'), 'summary.json'))).toBe(false);
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

describe('finalizeEndedRun seat identity', () => {
  it('persists the seat kinds beside their tools in the ending summary', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-ended-kinds';

    finalizeEndedRun({
      ref: { projectDir, sessionId },
      config: makeConfig({
        planner: { kind: 'cli', tool: 'claude-code', model: 'opus' },
        implementer: { kind: 'api', provider: 'ollama', model: 'qwen2.5-coder:7b' },
        reviewer: { kind: 'cli', tool: 'codex', model: 'gpt-5' },
      }),
      state: { ...createInitialState('feat'), phase: 'implementing' },
    });

    const session = readSession({ projectDir, sessionId });
    expect(session?.summary).toMatchObject({
      plannerTool: 'claude-code',
      plannerKind: 'cli',
      implementerTool: 'ollama',
      implementerKind: 'api',
      reviewerTool: 'codex',
      reviewerKind: 'cli',
    });
  });
});

describe('finalizeRunAtRest', () => {
  const ended = (): WorkflowState => ({
    ...createInitialState('feat'),
    phase: 'implementing',
    closed: { at: '2026-09-01T00:00:00.000Z', as: 'ended' },
  });

  it('clears the active session the ended run holds', () => {
    const projectDir = makeProjectDir();
    const ref = { projectDir, sessionId: 'sess-at-rest' };
    reactivateExistingSession(ref);

    finalizeRunAtRest({ ref, config: makeConfig(), state: ended() });

    expect(readSession(ref)?.status).toBe('ended');
    expect(existsSync(activeFile(projectDir))).toBe(false);
  });

  it('finalizes a checkout override as complete and clears its active receipt', () => {
    const projectDir = makeProjectDir();
    const ref = { projectDir, sessionId: 'sess-accepted-at-rest' };
    reactivateExistingSession(ref);
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'complete',
      reviewStatus: 'failed',
      acceptedAsIs: { at: '2026-09-01T00:00:00.000Z', findings: ['F1'] },
      workspace: { kind: 'checkout', path: projectDir, base: { snapshotId: 'base', head: null } },
    };
    finalizeRunAtRest({ ref, config: makeConfig(), state });
    expect(readSession(ref)?.status).toBe('complete');
    expect(shouldPreserveActiveState(state)).toBe(false);
    expect(state.reviewStatus).toBe('failed');
    expect(existsSync(activeFile(projectDir))).toBe(false);
  });

  it('leaves the active session of another run', () => {
    const projectDir = makeProjectDir();
    const other = reactivateExistingSession({ projectDir, sessionId: 'sess-other' });

    finalizeRunAtRest({
      ref: { projectDir, sessionId: 'sess-at-rest' },
      config: makeConfig(),
      state: ended(),
    });

    expect(readActiveRecord(projectDir)).toEqual({ kind: 'v1', receipt: other });
  });
});

describe('saveFinalSession for a run with a workspace', () => {
  const WORKSPACE: NonNullable<WorkflowState['workspace']> = {
    kind: 'worktree',
    path: '/tmp/wt',
    base: { snapshotId: 'workspace-base', head: null },
  };

  it('records a run ready to apply as open with no stop and keeps the active session', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-ready';
    const active = reactivateExistingSession({ projectDir, sessionId });
    const state: WorkflowState = { ...completedState(), workspace: WORKSPACE };

    saveFinalSession({
      projectDir,
      sessionId,
      active,
      feature: 'ready feature',
      startTime: 1,
      summary: makeSummary(),
      state,
    });

    const row = persisted(projectDir, sessionId);
    expect(row.status).toBe('open');
    expect(row.stop).toBeUndefined();
    expect(shouldPreserveActiveState(state)).toBe(true);
  });

  it.each([
    ['applied', 'complete'],
    ['discarded', 'ended'],
  ] as const)('records a run closed as %s as %s', (as, status) => {
    const projectDir = makeProjectDir();
    const sessionId = `sess-${as}`;
    const active = reactivateExistingSession({ projectDir, sessionId });

    saveFinalSession({
      projectDir,
      sessionId,
      active,
      feature: 'closed feature',
      startTime: 1,
      summary: makeSummary(),
      state: { ...completedState(), workspace: WORKSPACE, closed: { at: 'x', as } },
    });

    expect(persisted(projectDir, sessionId).status).toBe(status);
  });
});
