import { describe, expect, it, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { runTasksAndReview } from './task-execution.js';

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
    implement: vi.fn().mockImplementation(async () => {
      mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
      writeFileSync(join(opts.projectDir, 'src/alpha.ts'), `export const alpha = ${Date.now()};\n`);
      return { success: true, output: 'code', usage: { inputTokens: 10, outputTokens: 5 } };
    }),
  });
  const wctx = makeWctx({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    config: makeNoValidationConfig({ workflow: {} }),
    callbacks: makeCallbacks({ onComplete: opts.onComplete }).callbacks,
    bus,
    planner: reviewer,
    reviewer,
    implementer,
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
