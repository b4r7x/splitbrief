import { describe, expect, it, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import { runTasksAndReview } from './task-execution.js';

/** The sink the TUI installs, with the boundary pause pending exactly once. */
function pauseOnceSinks(): WorkflowSinks {
  let pending = true;
  return {
    setAbortHandler: () => {},
    setQueueHandler: () => {},
    consumeBoundaryPause: () => {
      const wasPending = pending;
      pending = false;
      return wasPending;
    },
  };
}

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string; head: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-execution-test',
    sessionId: 'sess-exec',
  });
  dirs.push(projectDir);
  const head = execSync('git rev-parse HEAD', {
    cwd: projectDir,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
  return { projectDir, sessionId, head };
}

function reviewedState(tasks: Task[], head: string, currentTaskIndex: number): WorkflowState {
  return {
    ...makeImplState(tasks),
    currentTaskIndex,
    changedFilesBaseline: { head, fingerprints: {}, runStartChangedFiles: [] },
  };
}

const SUMMARY_BASE = {
  feature: 'test feature',
  startTime: Date.now() - 1000,
  plannerTool: 'claude-code',
  implementerTool: 'ollama',
};

function runOptions(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  reviewText: string | ((call: number) => string);
  onComplete: () => void;
  sinks?: WorkflowSinks | undefined;
  onContinuationNeeded?: OrchestratorCallbacks['onContinuationNeeded'] | undefined;
}) {
  const { bus, events } = makeBusRecorder();
  let calls = 0;
  const reviewer = makePlanner({
    review: async () => {
      calls += 1;
      const text = typeof opts.reviewText === 'string' ? opts.reviewText : opts.reviewText(calls);
      return { text, usage: null };
    },
  });
  const implementer = makeImplementer({
    // Each brief writes the file it declared, so a run with more than one brief
    // does not read as an undeclared write.
    implement: vi.fn().mockImplementation(async (call: { task: Task }) => {
      const file = call.task.file ?? 'src/alpha.ts';
      mkdirSync(join(opts.projectDir, dirname(file)), { recursive: true });
      writeFileSync(join(opts.projectDir, file), `export const value = ${Date.now()};\n`);
      return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
    }),
  });
  const wctx = makeWctx({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    config: makeNoValidationConfig({ workflow: {} }),
    callbacks: makeCallbacks({
      onComplete: opts.onComplete,
      ...(opts.onContinuationNeeded !== undefined && {
        onContinuationNeeded: opts.onContinuationNeeded,
      }),
    }).callbacks,
    bus,
    planner: reviewer,
    reviewer,
    implementer,
    ...(opts.sinks !== undefined && { sinks: opts.sinks }),
  });
  return {
    events,
    implementer,
    options: {
      wctx,
      state: opts.state,
      planning: {
        disposition: 'ready-for-tasks' as const,
        state: opts.state,
        tasks: opts.state.tasks,
      },
      summaryBase: { ...SUMMARY_BASE, projectDir: opts.projectDir, sessionId: opts.sessionId },
      phaseTimings: {} as Record<string, number>,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    },
  };
}

describe('runTasksAndReview boundary pause', { timeout: 120_000 }, () => {
  it('parks between briefs, records the brief it stopped before, and continues into it', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', file: 'src/alpha.ts' }),
      makeTask({ id: 'T002', file: 'src/beta.ts' }),
    ];
    const parks: { partial: string; at: string }[] = [];
    const { events, implementer, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 0),
      reviewText: '### Verdict\npass\n',
      onComplete: vi.fn(),
      sinks: pauseOnceSinks(),
      onContinuationNeeded: async (partial, at) => {
        parks.push({ partial, at });
        return 'use the shared helper';
      },
    });

    const result = await runTasksAndReview(options);

    expect(parks).toEqual([{ partial: '', at: 'boundary' }]);
    expect(events.find((e) => e.type === 'turn_interrupted')).toMatchObject({
      source: 'user',
      at: 'boundary',
    });
    // Both briefs ran: the park held the run between them rather than ending it.
    expect(implementer.implement).toHaveBeenCalledTimes(2);
    expect(result.completed).toBe(true);
    // The park was cleared when the operator continued.
    expect(result.state.interruptedStep).toBeUndefined();
  });

  it('records a boundary park and stops when nothing can continue the run in place', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', file: 'src/alpha.ts' }),
      makeTask({ id: 'T002', file: 'src/beta.ts' }),
    ];
    const { implementer, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 0),
      reviewText: '### Verdict\npass\n',
      onComplete: vi.fn(),
      sinks: pauseOnceSinks(),
    });

    const result = await runTasksAndReview(options);

    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.state.interruptedStep).toMatchObject({
      step: { kind: 'brief', taskId: 'T002', attempt: 0 },
      source: 'user',
      cut: 'boundary',
    });
  });
});

describe('runTasksAndReview', { timeout: 120_000 }, () => {
  it('review fail dispatches REVIEW_DONE with reviewStatus failed and no onComplete', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })];
    const onComplete = vi.fn();
    const { events, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, tasks.length),
      reviewText: '### Verdict\nfail\n\n### Findings\n- **Warning**: the naming is loose\n',
      onComplete,
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(false);
    expect(result.state.reviewStatus).toBe('failed');
    expect(result.state.phase).toBe('complete');
    expect(onComplete).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'workflow_complete')).toMatchObject({
      review: 'failed',
      blocking: 0,
    });
    expect(events.find((e) => e.type === 'error' && e.code === 'review_failed')).toBeDefined();
    expect(result.state.pendingRecovery?.reason).toBe('review-failed');
  });

  it('re-enters the owning brief on a Critical finding and completes when the re-review passes', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })];
    const onComplete = vi.fn();
    const { events, implementer, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, tasks.length),
      reviewText: (call) =>
        call === 1
          ? '### Verdict\nfail\n\n### Findings\n- **Critical**: src/alpha.ts drops the error\n'
          : '### Verdict\npass\n',
      onComplete,
    });

    const result = await runTasksAndReview(options);

    expect(events.find((e) => e.type === 'review_fix_started')).toMatchObject({
      cycle: 0,
      taskIds: ['T001'],
    });
    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(true);
    expect(result.state.reviewStatus).toBe('passed');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'workflow_complete')).toMatchObject({ review: 'passed' });
  });
});
