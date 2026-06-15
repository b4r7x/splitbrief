import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { buildRetryExhaustedRecoveryIssue } from './recovery/builders/task.js';
import { readActive, writeActive } from '../../core/sessions/lifecycle.js';
import { activeFile, sessionDir } from '../../core/paths.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createInitialState } from '../../core/state/machine.js';
import type { Summary, CostBreakdown } from '../../core/schemas/summary.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { readStats } from '../../core/stats/persistence.js';
import {
  captureChangedFilesBaseline,
  serializeChangedFilesBaseline,
  withActiveTaskSnapshot,
} from './changed-files-baseline.js';
import { getChangedFilesSnapshot } from './approval/file-snapshots.js';
import {
  awaitActiveWorkflowShutdown,
  saveFinalSession,
  shouldPreserveActiveState,
  shutdownWorkflow,
  withShutdownHandlers,
} from './session-lifecycle.js';

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
    tokenUsage: {
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    },
    estimatedCostSavings: '$0.00',
    escalationRate: 0,
  };
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
    // First exit: the run is interrupted mid-flight and saved with a cost-bearing breakdown.
    saveFinalSession({
      projectDir,
      sessionId,
      feature: 'f',
      startTime: 1,
      status: 'interrupted',
      summary: makeCostBearingSummary(),
    });
    // Second exit: the same session is resumed and runs to completion.
    saveFinalSession({
      projectDir,
      sessionId,
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
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    saveFinalSession({
      projectDir,
      sessionId,
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
    writeActive({ projectDir: projectDir, sessionId: sessionId });

    saveFinalSession({
      projectDir,
      sessionId,
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
    // The pointer has since been handed to a different session.
    writeActive({ projectDir: projectDir, sessionId: 'sess-other' });

    saveFinalSession({
      projectDir,
      sessionId: 'sess-final',
      feature: 'f',
      startTime: 1,
      status: 'complete',
      summary: makeSummary(),
    });

    expect(readActive(projectDir)).toBe('sess-other');
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

  it.each([
    'planning',
    'implementing',
    'final-review',
  ] as const)('preserves resumable %s phase', (phase) => {
    const state: WorkflowState = { ...createInitialState('feat'), phase };
    expect(shouldPreserveActiveState(state)).toBe(true);
  });

  it('clears a non-resumable phase without explicit resume state', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'validating-task' };
    expect(shouldPreserveActiveState(state)).toBe(false);
  });

  it('clears a terminal phase with no pending recovery', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'complete' };
    expect(shouldPreserveActiveState(state)).toBe(false);
  });
});

function setupGitProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('session-lifecycle-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-final';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('shutdownWorkflow', () => {
  it('persists tracked state to disk when one is available', async () => {
    const { projectDir, sessionId } = setupGitProject();

    const trackedState: WorkflowState = {
      ...createInitialState('feat'),
      feature: 'shutdown-test',
    };

    await shutdownWorkflow(
      projectDir,
      sessionId,
      () => trackedState,
      () => undefined,
    );

    const statePath = join(sessionDir(projectDir, sessionId), 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(persisted.feature).toBe('shutdown-test');
  });

  it('is safe when there is no tracked state and no current task', async () => {
    const { projectDir, sessionId } = setupGitProject();
    await expect(
      shutdownWorkflow(
        projectDir,
        sessionId,
        () => undefined,
        () => undefined,
      ),
    ).resolves.toBeUndefined();
  });

  it('waits for current task rollback during shutdown', async () => {
    const { projectDir, sessionId } = setupGitProject();
    const file = 'src/generated.ts';
    const filePath = join(projectDir, file);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(filePath, 'export const generated = true;\n');

    await shutdownWorkflow(
      projectDir,
      sessionId,
      () => undefined,
      () => ({ file, action: 'create' }),
    );

    expect(existsSync(filePath)).toBe(false);
  });
});

function writeProjectFile(projectDir: string, file: string, content: string): void {
  const target = join(projectDir, file);
  mkdirSync(join(projectDir, file.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(target, content);
}

async function stateWithBaseline(projectDir: string, tasks: Task[]): Promise<WorkflowState> {
  const baseline = await captureChangedFilesBaseline(projectDir);
  return {
    ...createInitialState('feat'),
    phase: 'implementing',
    tasks,
    currentTaskIndex: 0,
    changedFilesBaseline: serializeChangedFilesBaseline(baseline),
  };
}

async function stateWithActiveTaskSnapshot(
  projectDir: string,
  tasks: Task[],
): Promise<WorkflowState> {
  const baseline = await captureChangedFilesBaseline(projectDir);
  const activeTaskSnapshot = await getChangedFilesSnapshot(projectDir);
  return {
    ...createInitialState('feat'),
    phase: 'implementing',
    tasks,
    currentTaskIndex: 0,
    changedFilesBaseline: serializeChangedFilesBaseline(
      withActiveTaskSnapshot(baseline, activeTaskSnapshot),
    ),
  };
}

describe('shutdownWorkflow — interrupted-task rollback', () => {
  it('discards the whole attributed set, not just task.file, for a multi-file task', async () => {
    const projectDir = createTempDir('session-lifecycle-test');
    dirs.push(projectDir);
    createTestGitRepo(projectDir, { 'src/a.ts': 'committed a\n' });
    const sessionId = 'sess-multi';
    ensureSessionDir(projectDir, sessionId);

    // Clean start: baseline captured before any task edits exist.
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/a.ts',
      scope: { inBounds: ['src/b.ts'] },
    });
    const trackedState = await stateWithBaseline(projectDir, [task]);

    // The implementer wrote two files of the task before the interrupt.
    writeProjectFile(projectDir, 'src/a.ts', 'partial agent a\n');
    writeProjectFile(projectDir, 'src/b.ts', 'partial agent b\n');

    await shutdownWorkflow(
      projectDir,
      sessionId,
      () => trackedState,
      () => ({ file: 'src/a.ts', action: 'modify' }),
    );

    expect(readFileSync(join(projectDir, 'src/a.ts'), 'utf-8')).toBe('committed a\n');
    expect(existsSync(join(projectDir, 'src/b.ts'))).toBe(false);
  });

  it('restores a pre-dirty attributed file to its exact pre-task content', async () => {
    const projectDir = createTempDir('session-lifecycle-test');
    dirs.push(projectDir);
    createTestGitRepo(projectDir, { 'src/a.ts': 'committed a\n' });
    const sessionId = 'sess-dirty';
    ensureSessionDir(projectDir, sessionId);

    // The user already had uncommitted edits to src/a.ts before the task started.
    writeProjectFile(projectDir, 'src/a.ts', 'user edit a\n');
    const task = makeTask({
      id: 'T001',
      action: 'modify',
      file: 'src/a.ts',
      scope: { inBounds: ['src/generated.ts'] },
    });
    const trackedState = await stateWithActiveTaskSnapshot(projectDir, [task]);

    // The implementer further changed the file during the task.
    writeProjectFile(projectDir, 'src/a.ts', 'agent a\n');
    writeProjectFile(projectDir, 'src/generated.ts', 'agent generated\n');

    await shutdownWorkflow(
      projectDir,
      sessionId,
      () => trackedState,
      () => ({ file: 'src/a.ts', action: 'modify' }),
    );

    expect(readFileSync(join(projectDir, 'src/a.ts'), 'utf-8')).toBe('user edit a\n');
    expect(existsSync(join(projectDir, 'src/generated.ts'))).toBe(false);
  });
});

describe('awaitActiveWorkflowShutdown — TUI exit alignment', () => {
  it('is a no-op when no workflow is running', async () => {
    await expect(awaitActiveWorkflowShutdown()).resolves.toBeUndefined();
  });

  it('runs the same rollback the signal path runs, sharing one shutdown', async () => {
    const projectDir = createTempDir('session-lifecycle-test');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-tui';
    ensureSessionDir(projectDir, sessionId);
    const file = 'src/generated.ts';

    let stateDuringRun: WorkflowState | undefined;
    await withShutdownHandlers(
      {
        projectDir,
        sessionId,
        getTrackedState: () => stateDuringRun,
        getCurrentTask: () => ({ file, action: 'create' }),
      },
      async () => {
        const task = makeTask({ id: 'T001', action: 'create', file });
        stateDuringRun = await stateWithBaseline(projectDir, [task]);
        writeProjectFile(projectDir, file, 'export const generated = true;\n');

        // The TUI host awaits this on a fullscreen kill before exiting the process.
        await awaitActiveWorkflowShutdown();
        expect(existsSync(join(projectDir, file))).toBe(false);
      },
    );

    // The handle is cleared once the run unwinds.
    await expect(awaitActiveWorkflowShutdown()).resolves.toBeUndefined();
  });
});
