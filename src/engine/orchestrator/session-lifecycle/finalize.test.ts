import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { activeFile, SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { Session } from '../../../core/schemas/session.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import {
  finalizeEndedRun,
  finalizeRunAtRest,
  reopenSessionRecord,
  saveFinalSession,
} from './finalize.js';
import { readSession } from '../../../core/sessions/io.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { writeSeatIdentities } from '../../../core/state/seats.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { RUN_CREW } from '#testing/helpers/factories/workflow-state.js';

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

function writeLog(
  projectDir: string,
  sessionId: string,
  events: readonly (readonly [string, string, Record<string, unknown>?])[],
): void {
  mkdirSync(sessionDir(projectDir, sessionId), { recursive: true });
  const lines = events.map(([type, ts, data = {}]) =>
    JSON.stringify({ kind: 'event', ts, type, phase: 'implementing', data }),
  );
  writeFileSync(join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE), lines.join('\n'));
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

  it('records how long the run ran and its phase times from its log, and nothing without a log', () => {
    const projectDir = makeProjectDir();
    writeLog(projectDir, 'sess-ran', [
      ['workflow_started', '2026-10-15T10:00:00.000Z'],
      ['turn_interrupted', '2026-10-15T10:01:00.000Z'],
      ['workflow_resumed', '2026-10-16T09:00:00.000Z'],
      ['workflow_complete', '2026-10-16T09:00:30.000Z'],
    ]);
    const save = (sessionId: string) =>
      saveFinalSession({
        projectDir,
        sessionId,
        feature: 'feat',
        startTime: 1,
        summary: makeSummary(),
        state: completedState(),
      });

    save('sess-ran');
    save('sess-no-log');

    expect(readSession({ projectDir, sessionId: 'sess-ran' })?.summary).toMatchObject({
      activeTime: 90_000,
      phaseTimings: { implementing: 90_000 },
    });
    const noLog = readSession({ projectDir, sessionId: 'sess-no-log' })?.summary;
    expect(noLog).not.toHaveProperty('activeTime');
    expect(noLog).not.toHaveProperty('phaseTimings');
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

describe('finalizeEndedRun seat identity', () => {
  it('names the crew the run recorded, not the crew saved now', () => {
    const projectDir = makeProjectDir();
    const ref = { projectDir, sessionId: 'sess-ended-kinds' };
    ensureSessionDir(projectDir, ref.sessionId);
    writeSeatIdentities(ref, {
      plan: 'Claude Code · Opus',
      build: 'Ollama · qwen2.5-coder:7b',
      review: 'OpenAI Codex CLI · gpt-5',
      ids: {
        plan: { tool: 'claude-code', model: 'opus', axes: [], kind: 'cli' },
        build: { tool: 'ollama', model: 'qwen2.5-coder:7b', axes: [], kind: 'api' },
        review: { tool: 'codex', model: 'gpt-5', axes: [], kind: 'cli' },
      },
    });

    finalizeEndedRun({ ref, state: { ...createInitialState('feat'), phase: 'implementing' } });

    expect(readSession(ref)?.summary).toMatchObject({
      plannerTool: 'claude-code',
      plannerModel: 'opus',
      plannerKind: 'cli',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:7b',
      implementerKind: 'api',
      reviewerTool: 'codex',
      reviewerModel: 'gpt-5',
      reviewerKind: 'cli',
    });
  });

  it('leaves the review seat to the planner when an older record kept one seat for both and the run had no reviewer', () => {
    const projectDir = makeProjectDir();
    const ref = { projectDir, sessionId: 'sess-planner-reviews' };
    ensureSessionDir(projectDir, ref.sessionId);
    const plan = { tool: 'claude-code', model: 'auto', axes: [], kind: 'cli' } as const;
    writeSeatIdentities(ref, {
      plan: 'Claude Code',
      build: 'Claude Code · Haiku',
      review: 'Claude Code',
      ids: { plan, build: { ...plan, model: 'haiku' }, review: plan },
    });

    finalizeRunAtRest({ ref, state: { ...createInitialState('feat'), phase: 'implementing' } });

    const summary = readSession(ref)?.summary;
    expect(summary).toMatchObject({ plannerTool: 'claude-code', implementerModel: 'haiku' });
    expect(summary?.plannerModel).toBeUndefined();
    expect(summary?.reviewerTool).toBeUndefined();
  });

  it('names the reviewer of an older record that kept one seat for both when the run started with a reviewer', () => {
    const projectDir = makeProjectDir();
    const ref = { projectDir, sessionId: 'sess-older-own-reviewer' };
    ensureSessionDir(projectDir, ref.sessionId);
    const plan = { tool: 'claude-code', model: 'opus', axes: [], kind: 'cli' } as const;
    writeSeatIdentities(ref, {
      plan: 'Claude Code · Opus',
      build: 'Claude Code · Haiku',
      review: 'Claude Code · Opus',
      ids: { plan, build: { ...plan, model: 'haiku' }, review: plan },
    });

    finalizeRunAtRest({
      ref,
      state: {
        ...createInitialState('feat'),
        phase: 'implementing',
        reviewerTool: 'claude-code',
        reviewerModel: 'opus',
        reviewerKind: 'cli',
      },
    });

    expect(readSession(ref)?.summary).toMatchObject({
      reviewerTool: 'claude-code',
      reviewerModel: 'opus',
      reviewerKind: 'cli',
    });
  });

  it('keeps the brief each BUILD seat built, with its retries and profile', () => {
    const projectDir = makeProjectDir();
    const ref = { projectDir, sessionId: 'sess-two-build-seats' };
    const brief = { method: 'local', implementerTokens: 10, escalationTokens: 0 } as const;
    const taskBreakdowns = [
      {
        ...brief,
        taskId: makeTask({ id: 'T001' }).id,
        taskTitle: 'First',
        retryCount: 2,
        tool: 'claude-code',
        model: 'haiku',
        implementerProfile: 'quick',
      },
      {
        ...brief,
        taskId: makeTask({ id: 'T002' }).id,
        taskTitle: 'Second',
        retryCount: 0,
        tool: 'antigravity',
        model: 'auto',
        implementerProfile: 'default',
      },
    ];

    finalizeRunAtRest({
      ref,
      state: { ...createInitialState('feat'), ...RUN_CREW, phase: 'implementing', taskBreakdowns },
    });

    expect(readSession(ref)?.summary?.taskBreakdown).toMatchObject(taskBreakdowns);
  });

  it('reads the seats an older record kept in its state', () => {
    const projectDir = makeProjectDir();
    const ref = { projectDir, sessionId: 'sess-older-record' };

    finalizeRunAtRest({
      ref,
      state: {
        ...createInitialState('feat'),
        phase: 'implementing',
        plannerTool: 'claude-code',
        plannerModel: 'opus',
        plannerKind: 'cli',
        implementerTool: 'codex',
        implementerModel: 'gpt-5',
        implementerKind: 'cli',
      },
    });

    const summary = readSession(ref)?.summary;
    expect(summary).toMatchObject({
      plannerTool: 'claude-code',
      plannerModel: 'opus',
      implementerTool: 'codex',
      implementerModel: 'gpt-5',
    });
    expect(summary?.reviewerTool).toBeUndefined();
  });
});

describe('finalizeEndedRun after a live End', () => {
  it('counts the wait the run was in when the End came', () => {
    const projectDir = makeProjectDir();
    const ref = { projectDir, sessionId: 'sess-ended-live' };
    writeLog(projectDir, ref.sessionId, [
      ['workflow_started', '2026-10-15T10:00:00.000Z'],
      ['plan_ready', '2026-10-15T10:01:00.000Z'],
      ['workflow_cancelled', '2026-10-15T10:11:00.000Z', { reason: 'user_cancelled' }],
    ]);

    finalizeEndedRun({
      ref,
      state: {
        ...createInitialState('feat'),
        ...RUN_CREW,
        phase: 'planning',
        closed: { at: '2026-10-15T10:11:00.000Z', as: 'ended' },
      },
    });

    expect(readSession(ref)?.summary?.activeTime).toBe(11 * 60_000);
  });
});

describe('finalizeRunAtRest', () => {
  const ended = (): WorkflowState => ({
    ...createInitialState('feat'),
    ...RUN_CREW,
    phase: 'implementing',
    closed: { at: '2026-09-01T00:00:00.000Z', as: 'ended' },
  });

  it('clears the active session the ended run holds', () => {
    const projectDir = makeProjectDir();
    const ref = { projectDir, sessionId: 'sess-at-rest' };
    reactivateExistingSession(ref);

    finalizeRunAtRest({ ref, state: ended() });

    expect(readSession(ref)?.status).toBe('ended');
    expect(existsSync(activeFile(projectDir))).toBe(false);
  });

  it('finalizes a checkout override as complete and clears its active receipt', () => {
    const projectDir = makeProjectDir();
    const ref = { projectDir, sessionId: 'sess-accepted-at-rest' };
    reactivateExistingSession(ref);
    const state: WorkflowState = {
      ...createInitialState('feat'),
      ...RUN_CREW,
      phase: 'complete',
      reviewStatus: 'failed',
      acceptedAsIs: { at: '2026-09-01T00:00:00.000Z', findings: ['F1'] },
      workspace: { kind: 'checkout', path: projectDir, base: { snapshotId: 'base', head: null } },
    };
    finalizeRunAtRest({ ref, state });
    expect(readSession(ref)?.status).toBe('complete');
    expect(state.reviewStatus).toBe('failed');
    expect(existsSync(activeFile(projectDir))).toBe(false);
  });

  it('leaves the days a crashed run sat at rest out of the run its End closes', () => {
    const projectDir = makeProjectDir();
    const ref = { projectDir, sessionId: 'sess-crashed' };
    writeLog(projectDir, ref.sessionId, [
      ['workflow_started', '2026-10-10T10:00:00.000Z'],
      ['task_started', '2026-10-10T10:05:00.000Z'],
      ['workspace_closed', '2026-10-13T10:00:00.000Z'],
      [
        'workflow_cancelled',
        '2026-10-13T10:00:00.010Z',
        { atRestFrom: Date.parse('2026-10-13T10:00:00.000Z') },
      ],
    ]);

    finalizeRunAtRest({ ref, state: ended() });

    expect(readSession(ref)?.summary?.activeTime).toBe(5 * 60_000);
  });

  it('leaves the active session of another run', () => {
    const projectDir = makeProjectDir();
    const other = reactivateExistingSession({ projectDir, sessionId: 'sess-other' });

    finalizeRunAtRest({
      ref: { projectDir, sessionId: 'sess-at-rest' },
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
