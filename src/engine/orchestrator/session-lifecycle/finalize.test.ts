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
} from '../../../core/sessions/lifecycle.js';
import { randomUUID } from 'node:crypto';
import { activeFile, sessionDir } from '../../../core/paths.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { Summary, CostBreakdown } from '../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { readStats } from '../../../core/stats/persistence.js';
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
    estimatedCostSavings: '$0.00',
    escalationRate: 0,
  };
}

function receipt(sessionId: string): ActiveSessionReceipt {
  return { version: 1, sessionId, generation: randomUUID() };
}

function makeCostBreakdown(): CostBreakdown {
  return {
    hypotheticalCost: 0.95,
    actualPlannerCost: 0.05,
    actualImplementerCost: 0.07,
    totalActualCost: 0.12,
    savingsAmount: 0.88,
    savingsPercentage: 93,
    localCompletionRate: 0.92,
    hasPricedUsage: true,
    hasUnpricedUsage: false,
    hasSavingsEstimate: true,
    isActualPlannerCostKnown: true,
    isActualImplementerCostKnown: true,
    isTotalActualCostKnown: true,
    isAllPlannerBaselineKnown: true,
  };
}

function makeCostBearingSummary(): Summary {
  return {
    ...makeSummary(),
    completedByLocal: 1,
    totalTasks: 1,
    costBreakdown: makeCostBreakdown(),
  };
}

describe('saveFinalSession — lifetime stats gate', () => {
  it('does not book lifetime stats for a non-complete exit even with a cost-bearing breakdown', () => {
    const projectDir = makeProjectDir();
    saveFinalSession({
      projectDir,
      sessionId: 'sess-interrupted',
      active: receipt('sess-interrupted'),
      feature: 'f',
      startTime: 1,
      status: 'interrupted',
      summary: makeCostBearingSummary(),
    });

    expect(readStats(projectDir).totalSessions).toBe(0);
  });

  it('books lifetime stats exactly once for a complete exit', () => {
    const projectDir = makeProjectDir();
    saveFinalSession({
      projectDir,
      sessionId: 'sess-complete',
      active: receipt('sess-complete'),
      feature: 'f',
      startTime: 1,
      status: 'complete',
      summary: makeCostBearingSummary(),
    });

    const stats = readStats(projectDir);
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalCost).toBeCloseTo(0.12);
    expect(stats.totalHypotheticalCost).toBeCloseTo(0.95);
  });

  it('books an interrupted-then-resumed session exactly once across both exits', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-resumed';
    saveFinalSession({
      projectDir,
      sessionId,
      active: receipt(sessionId),
      feature: 'f',
      startTime: 1,
      status: 'interrupted',
      summary: makeCostBearingSummary(),
    });
    saveFinalSession({
      projectDir,
      sessionId,
      active: receipt(sessionId),
      feature: 'f',
      startTime: 1,
      status: 'complete',
      summary: makeCostBearingSummary(),
    });

    const stats = readStats(projectDir);
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalCost).toBeCloseTo(0.12);
    expect(stats.totalHypotheticalCost).toBeCloseTo(0.95);
  });
});

describe('saveFinalSession', () => {
  it('clears the active session by default', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-final';
    const active = reactivateExistingSession({ projectDir, sessionId });

    saveFinalSession({
      projectDir,
      sessionId,
      active,
      feature: 'final feature',
      startTime: 1,
      status: 'interrupted',
      summary: makeSummary(),
    });

    expect(existsSync(activeFile(projectDir))).toBe(false);
  });

  it('preserves the active session for recoverable pending recovery stops', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-recovery';
    const active = reactivateExistingSession({ projectDir, sessionId });

    saveFinalSession({
      projectDir,
      sessionId,
      active,
      feature: 'recoverable feature',
      startTime: 1,
      status: 'interrupted',
      summary: makeSummary(),
      preserveActive: true,
    });

    expect(readActive(projectDir)).toBe(sessionId);
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
      status: 'complete',
      summary: makeSummary(),
    });

    const summaryPath = join(sessionDir(projectDir, sessionId), 'summary.json');
    const persisted = JSON.parse(readFileSync(summaryPath, 'utf-8'));
    expect('stateFile' in persisted).toBe(false);
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
      status: 'complete',
      summary: makeSummary(),
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
      status: 'interrupted',
      summary: makeSummary(),
    });

    expect(readActiveRecord(projectDir)).toEqual({ kind: 'v1', receipt: newer });
  });
});

describe('shouldPreserveActiveState', () => {
  it('clears when there is no loaded state', () => {
    expect(shouldPreserveActiveState(null)).toBe(false);
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

  it('preserves awaiting-continue state for a non-resumable phase', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      awaitingContinue: true,
    };
    expect(shouldPreserveActiveState(state)).toBe(true);
  });

  it.each(['planning', 'reviewing-briefs', 'implementing', 'final-review'] as const)(
    'preserves resumable %s phase',
    (phase) => {
      const state: WorkflowState = { ...createInitialState('feat'), phase };
      expect(shouldPreserveActiveState(state)).toBe(true);
    },
  );

  it('clears a non-resumable phase without explicit resume state', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'validating-task' };
    expect(shouldPreserveActiveState(state)).toBe(false);
  });

  it('clears a terminal phase with no pending recovery', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'complete' };
    expect(shouldPreserveActiveState(state)).toBe(false);
  });
});
