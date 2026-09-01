import { describe, it, expect, afterEach } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { saveState } from '../../../core/state/persistence.js';
import { listSessions } from '../../../core/sessions/io.js';
import {
  readActive,
  reactivateExistingSession,
  type ActiveSessionReceipt,
} from '../../../core/sessions/active-pointer.js';
import { randomUUID } from 'node:crypto';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../../../core/transcript-policy.js';
import { readStats } from '../../../core/stats/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { buildContextOverflowRecoveryIssue } from './builders/task.js';
import { finalizeRecoveryResult, loadPendingRecoveryState } from './driver.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

let dirs: string[] = [];

function receipt(sessionId: string): ActiveSessionReceipt {
  return { version: 1, sessionId, generation: randomUUID() };
}

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function newSession(sessionId: string): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('recovery-driver-test');
  dirs.push(projectDir);
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('loadPendingRecoveryState', () => {
  it('returns a persisted recovery issue as pending', () => {
    const { projectDir, sessionId } = newSession('sess-recovery');
    const task = makeTask({ id: 'T001' });
    const issue = buildContextOverflowRecoveryIssue({
      task,
      phase: 'implementing',
      createdAt: '2026-04-28T12:00:00.000Z',
    });
    const state: WorkflowState = {
      ...makeImplState([task]),
      pendingRecovery: { ...issue, status: 'awaiting-user' },
    };
    saveState({ projectDir, sessionId }, state);

    const loaded = loadPendingRecoveryState({ projectDir, sessionId }, state);
    expect(loaded.pending).toBe(true);
    if (loaded.pending) {
      expect(loaded.issue).toEqual(state.pendingRecovery);
    }
  });

  it('reports no pending recovery when state has none', () => {
    const { projectDir, sessionId } = newSession('sess-clean');
    const state = makeImplState([makeTask({ id: 'T001' })]);
    saveState({ projectDir, sessionId }, state);
    const loaded = loadPendingRecoveryState({ projectDir, sessionId }, state);
    expect(loaded.pending).toBe(false);
  });
});

describe('finalizeRecoveryResult — detached abort', () => {
  it('finalizes the aborted session summary from the pre-CANCEL work, not the gutted idle state', () => {
    const { projectDir, sessionId } = newSession('sess-aborted');
    const active = reactivateExistingSession({ projectDir, sessionId });

    // Pre-CANCEL state: the work the detached server completed before the abort answer.
    const preCancelState: WorkflowState = {
      ...makeImplState([
        makeTask({ id: 'T001', status: 'done' }),
        makeTask({ id: 'T002', status: 'done' }),
        makeTask({ id: 'T003', status: 'pending' }),
      ]),
      feature: 'aborted-feature',
      tokenUsage: makeUsage({
        plannerInput: 1000,
        plannerOutput: 500,
        implementerInput: 2000,
        implementerOutput: 800,
      }),
    };

    finalizeRecoveryResult({
      projectDir,
      sessionId,
      active,
      state: preCancelState,
      config: makeConfig(),
      status: 'aborted',
    });

    const session = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(session).toBeDefined();
    // The record is finalized (not left at 'interrupted'-forever by an exit-0 server)
    // with a real summary describing the pre-CANCEL work.
    expect(session?.status).toBe('interrupted');
    expect(session?.feature).toBe('aborted-feature');
    // totalTasks reflects the pre-CANCEL task set — not a gutted idle state with zero tasks.
    expect(session?.summary?.totalTasks).toBe(3);
    expect(session?.summary?.completedByLocal).toBe(2);
    // The surviving token usage is carried into the finalized summary, not zeroed.
    expect(session?.summary?.tokenUsage.implementerInput).toBe(2000);
    expect(readActive(projectDir)).toBeNull();
  });

  it('finalizes the abort summary with the reviewer seat the run was pinned to', () => {
    const { projectDir, sessionId } = newSession('sess-aborted-reviewer');

    finalizeRecoveryResult({
      projectDir,
      sessionId,
      active: receipt(sessionId),
      state: {
        ...makeImplState([makeTask({ id: 'T001', status: 'done' })]),
        feature: 'aborted-reviewer-feature',
        reviewerTool: 'custom-reviewer',
        reviewerModel: 'deepseek-v4-flash',
      },
      config: makeConfig({
        reviewer: {
          kind: 'api',
          provider: 'custom-endpoint',
          model: 'swapped-after-the-run',
          apiBase: 'https://api.example.com/v1',
          apiKey: 'test-key',
        },
      }),
      status: 'aborted',
    });

    const session = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(session?.summary?.reviewerTool).toBe('custom-reviewer');
    expect(session?.summary?.reviewerModel).toBe('deepseek-v4-flash');
  });

  it('redacts feature text from the finalized abort summary when persistTranscript is false', () => {
    const { projectDir, sessionId } = newSession('sess-aborted-redacted');

    const secretFeature = 'wire up the unreleased acquisition pricing endpoint';
    finalizeRecoveryResult({
      projectDir,
      sessionId,
      active: receipt(sessionId),
      state: {
        ...makeImplState([makeTask({ id: 'T001', status: 'done' })]),
        feature: secretFeature,
      },
      config: makeConfig({ workflow: { persistTranscript: false } }),
      status: 'aborted',
    });

    const session = listSessions(projectDir).find((s) => s.id === sessionId);
    expect(session).toBeDefined();
    expect(session?.feature).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(session?.summary?.feature).toBe(TRANSCRIPT_OMITTED_MESSAGE);
    expect(JSON.stringify(session)).not.toContain(secretFeature);
  });

  it('does not double-book lifetime stats for an aborted session', () => {
    const { projectDir, sessionId } = newSession('sess-aborted-stats');

    finalizeRecoveryResult({
      projectDir,
      sessionId,
      active: receipt(sessionId),
      state: {
        ...makeImplState([
          makeTask({ id: 'T001', status: 'done' }),
          makeTask({ id: 'T002', status: 'done' }),
        ]),
        feature: 'aborted-stats-feature',
      },
      config: makeConfig(),
      status: 'aborted',
    });

    // An interrupted abort must not accumulate lifetime stats — otherwise the session
    // would be double-booked once with zeroed counts.
    const stats = readStats(projectDir);
    expect(stats.totalSessions).toBe(0);
    expect(stats.totalTasks).toBe(0);
  });

  it('does nothing for a non-aborted status', () => {
    const { projectDir, sessionId } = newSession('sess-not-aborted');

    finalizeRecoveryResult({
      projectDir,
      sessionId,
      active: receipt(sessionId),
      state: makeImplState([makeTask({ id: 'T001' })]),
      config: makeConfig(),
      status: 'retry-current-task',
    });

    expect(listSessions(projectDir).find((s) => s.id === sessionId)).toBeUndefined();
  });
});
