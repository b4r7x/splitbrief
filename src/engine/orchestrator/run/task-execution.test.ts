import { describe, expect, it, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeConfig, makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import type { Validator } from '../validation/types.js';
import type {
  Implementer,
  ImplementerOptions,
  ImplementerResult,
  RetryOptions,
} from '../../implementers/types.js';
import type { ContinuationHolder } from '../continuation.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import { createStdoutTextSink } from '../../events/sinks/stdout-text.js';
import { runTasksAndReview } from './task-execution.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { createValidator } from '../validation/run.js';
import { formatRetryPrompt } from '../../spec/prompt-formatter.js';

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

/** A run re-entered at an unfinished final review, carrying the cycles already spent. */
function resumedReviewState(tasks: Task[], head: string, cycle: number): WorkflowState {
  return {
    ...reviewedState(tasks, head, tasks.length),
    phase: 'final-review',
    reviewFixes: { cycle, findings: {} },
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
  signal?: AbortSignal | undefined;
  onContinuationNeeded?: OrchestratorCallbacks['onContinuationNeeded'] | undefined;
  continuation?: ContinuationHolder | undefined;
  skillsContext?: string | undefined;
  implementer?: Implementer | undefined;
  config?: Config | undefined;
  validator?: Validator | undefined;
}) {
  const { bus, events } = makeBusRecorder();
  let calls = 0;
  const reviewPrompts: string[] = [];
  const reviewer = makePlanner({
    review: async (prompt: string) => {
      reviewPrompts.push(prompt);
      calls += 1;
      const text = typeof opts.reviewText === 'string' ? opts.reviewText : opts.reviewText(calls);
      return { text, usage: null };
    },
  });
  const implementer =
    opts.implementer ??
    makeImplementer({
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
    config: opts.config ?? makeNoValidationConfig({ workflow: {} }),
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
    ...(opts.signal !== undefined && { signal: opts.signal }),
    ...(opts.continuation !== undefined && { continuation: opts.continuation }),
    ...(opts.validator !== undefined && { validator: opts.validator }),
    ...(opts.skillsContext !== undefined && {
      context: { name: 'demo', dir: opts.projectDir, skillsContext: opts.skillsContext },
    }),
  });
  return {
    events,
    reviewPrompts,
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
      step: { kind: 'brief', taskId: 'T002', attempt: 0 },
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
      cycle: 1,
      taskIds: ['T001'],
    });
    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(true);
    expect(result.state.reviewStatus).toBe('passed');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'workflow_complete')).toMatchObject({ review: 'passed' });
  });

  it("closes a continued run with the run's completed briefs, not only the ones it ran", async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' }),
      makeTask({ id: 'T002', file: 'src/beta.ts' }),
    ];
    const { events, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 1),
      reviewText: '### Verdict\npass\n',
      onComplete: vi.fn(),
    });

    await runTasksAndReview(options);
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const sink = createStdoutTextSink({ output });
    for (const event of events) sink(event);

    expect(events.filter((e) => e.type === 'task_completed')).toHaveLength(1);
    expect(events.find((e) => e.type === 'workflow_complete')).toMatchObject({
      completedTasks: 2,
    });
    expect(chunks.join('').trimEnd().split('\n').at(-1)).toBe('done: 2 tasks');
  });
});

const CRITICAL_FAIL =
  '### Verdict\nfail\n\n### Findings\n- **Critical**: src/alpha.ts drops the error\n';

const TWO_CRITICAL_FAIL =
  '### Verdict\nfail\n\n### Findings\n- **Critical**: src/alpha.ts drops the error\n- **Critical**: src/beta.ts drops the error\n';

/**
 * A direct writer that edits nothing, held to the CLI implementer's zero-change
 * rule: only an attempt allowed to change nothing may complete that way.
 */
function noChangeImplementer(): Implementer {
  const attempt = async (call: ImplementerOptions): Promise<ImplementerResult> =>
    call.allowNoChange === true
      ? { success: true, output: 'already done' }
      : {
          success: false,
          output: 'nothing to do',
          error: 'Tool implementer (claude-code) exited without changing any files',
          outcome: 'no-staged-change',
        };
  return makeImplementer({
    implement: vi.fn().mockImplementation(attempt),
    retry: vi.fn().mockImplementation(attempt),
  });
}

describe('runTasksAndReview review fix with nothing to change', { timeout: 120_000 }, () => {
  it('completes each reopened brief that needs no change and runs the final review again', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' }),
      makeTask({ id: 'T002', file: 'src/beta.ts', status: 'done' }),
    ];
    const implementer = noChangeImplementer();
    const onComplete = vi.fn();
    const { events, reviewPrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, tasks.length),
      reviewText: (call) => (call === 1 ? TWO_CRITICAL_FAIL : '### Verdict\npass\n'),
      onComplete,
      implementer,
    });

    const result = await runTasksAndReview(options);

    expect(events.find((e) => e.type === 'review_fix_started')).toMatchObject({
      taskIds: ['T001', 'T002'],
    });
    expect(vi.mocked(implementer.retry).mock.calls.map(([call]) => call.task.id)).toEqual([
      'T001',
      'T002',
    ]);
    expect(
      vi.mocked(implementer.retry).mock.calls.every(([call]) => call.allowNoChange === true),
    ).toBe(true);
    expect(
      events.filter((e) => e.type === 'task_completed').map((e) => 'taskId' in e && e.taskId),
    ).toEqual(['T001', 'T002']);
    expect(events.find((e) => e.type === 'task_escalating')).toBeUndefined();
    expect(result.state.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    expect(reviewPrompts).toHaveLength(2);
    expect(result.completed).toBe(true);
    expect(result.state.reviewStatus).toBe('passed');
    expect(result.state.pendingRecovery).toBeUndefined();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('Try again on a fix attempt parked by the old zero-change rule completes the brief', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })];
    const refusing = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        output: 'nothing to do',
        error: 'Tool implementer (claude-code) exited without changing any files',
        outcome: 'no-staged-change',
      }),
    });
    const parked = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, tasks.length),
      reviewText: CRITICAL_FAIL,
      onComplete: vi.fn(),
      implementer: refusing,
    });
    const halted = await runTasksAndReview(parked.options);
    expect(halted.state.pendingRecovery?.availableActions).toContain('retry-same-worker');

    const { bus } = makeBusRecorder();
    const retried = applyRecoveryAction({
      projectDir,
      sessionId,
      state: halted.state,
      action: 'retry-same-worker',
      bus,
    });
    expect(retried.ok).toBe(true);

    const implementer = noChangeImplementer();
    const { events, options } = runOptions({
      projectDir,
      sessionId,
      state: retried.state,
      reviewText: '### Verdict\npass\n',
      onComplete: vi.fn(),
      implementer,
    });
    const result = await runTasksAndReview(options);

    expect(implementer.retry).toHaveBeenCalledWith(
      expect.objectContaining({ allowNoChange: true }),
    );
    expect(events.find((e) => e.type === 'task_completed')).toMatchObject({ taskId: 'T001' });
    expect(events.find((e) => e.type === 'task_escalating')).toBeUndefined();
    expect(result.state.tasks[0]?.status).toBe('done');
    expect(result.completed).toBe(true);
    expect(result.state.reviewStatus).toBe('passed');
  });

  it('still escalates a brief that is not reopened when it changes nothing', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' }),
      makeTask({ id: 'T002', file: 'src/beta.ts' }),
    ];
    const implementer = noChangeImplementer();
    const { events, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 1),
      reviewText: '### Verdict\npass\n',
      onComplete: vi.fn(),
      implementer,
    });

    const result = await runTasksAndReview(options);

    expect(vi.mocked(implementer.implement).mock.calls[0]?.[0].allowNoChange).not.toBe(true);
    expect(events.find((e) => e.type === 'task_escalating')).toMatchObject({ taskId: 'T002' });
    expect(events.find((e) => e.type === 'task_completed')).toBeUndefined();
    expect(result.completed).toBe(false);
    expect(result.state.tasks[1]?.status).not.toBe('done');
  });
});

const REVIEW_FIX_INSTRUCTION = 'These findings come from the final review.';

/** A direct writer that writes its brief's file and records every retry prompt it is given. */
function promptRecordingImplementer(projectDir: string, prompts: string[]): Implementer {
  const write = (task: Task): void => {
    const file = task.file ?? 'src/alpha.ts';
    mkdirSync(join(projectDir, dirname(file)), { recursive: true });
    writeFileSync(join(projectDir, file), `export const value = ${Date.now()};\n`);
  };
  return makeImplementer({
    implement: vi.fn().mockImplementation(async (call: ImplementerOptions) => {
      write(call.task);
      return { success: true, output: 'code' };
    }),
    retry: vi.fn().mockImplementation(async (call: RetryOptions) => {
      prompts.push(
        formatRetryPrompt({
          task: call.task,
          context: call.context,
          error: call.error,
          attempt: call.attempt,
          writesFiles: 'direct',
        }),
      );
      write(call.task);
      return { success: true, output: 'fixed' };
    }),
  });
}

describe('runTasksAndReview review fix instruction', { timeout: 120_000 }, () => {
  it('puts the fixed instruction once, before the findings, in a reopened brief prompt', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })];
    const prompts: string[] = [];
    const { options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, tasks.length),
      reviewText: (call) => (call === 1 ? CRITICAL_FAIL : '### Verdict\npass\n'),
      onComplete: vi.fn(),
      implementer: promptRecordingImplementer(projectDir, prompts),
    });

    await runTasksAndReview(options);

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? '';
    expect(prompt.split(REVIEW_FIX_INSTRUCTION)).toHaveLength(2);
    expect(prompt).toContain('do not search for those files, and do not leave this directory');
    expect(prompt).toContain('may change any ordinary project file the fix needs');
    expect(prompt).not.toContain("inside this brief's files");
    expect(prompt).toContain('src/alpha.ts drops the error');
    expect(prompt.indexOf(REVIEW_FIX_INSTRUCTION)).toBeLessThan(
      prompt.indexOf('src/alpha.ts drops the error'),
    );
  });

  it('leaves the instruction out of a retry after a validation failure', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', file: 'src/alpha.ts' })];
    const prompts: string[] = [];
    let validations = 0;
    const { options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 0),
      reviewText: '### Verdict\npass\n',
      onComplete: vi.fn(),
      implementer: promptRecordingImplementer(projectDir, prompts),
      config: makeConfig({
        validation: { typecheck: true, lint: false, test: false, typecheckCommand: 'noop' },
        workflow: { maxRetries: 1 },
      }),
      validator: {
        ...createValidator(),
        runValidation: vi.fn().mockImplementation(async () => {
          validations += 1;
          return [
            {
              stage: 'typecheck' as const,
              passed: validations > 1,
              error: validations > 1 ? undefined : 'TS2322 in src/alpha.ts',
              failureFiles: validations > 1 ? [] : ['src/alpha.ts'],
            },
          ];
        }),
      },
    });

    await runTasksAndReview(options);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('TS2322 in src/alpha.ts');
    expect(prompts[0]).not.toContain(REVIEW_FIX_INSTRUCTION);
  });
});

describe('runTasksAndReview repair budget', { timeout: 120_000 }, () => {
  it('resumes a persisted cycle 1 with only cycle 2 left, and completes when the re-review passes', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })];
    const onComplete = vi.fn();
    const { events, implementer, options } = runOptions({
      projectDir,
      sessionId,
      state: resumedReviewState(tasks, head, 1),
      reviewText: (call) => (call === 1 ? CRITICAL_FAIL : '### Verdict\npass\n'),
      onComplete,
    });

    const result = await runTasksAndReview(options);

    const fixEvents = events.filter((e) => e.type === 'review_fix_started');
    expect(fixEvents).toHaveLength(1);
    expect(fixEvents[0]).toMatchObject({ cycle: 2, taskIds: ['T001'] });
    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(result.state.reviewFixes?.cycle).toBe(2);
    expect(result.completed).toBe(true);
    expect(result.state.reviewStatus).toBe('passed');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("hands the final review the run's skills context", async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })];
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nREVIEW-SKILL-BODY';
    const { reviewPrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: resumedReviewState(tasks, head, 0),
      reviewText: '### Verdict\npass\n',
      onComplete: vi.fn(),
      skillsContext,
    });

    await runTasksAndReview(options);

    expect(reviewPrompts).toEqual([expect.stringContaining(skillsContext)]);
  });

  it('a failing review at persisted cycle 2 repairs nothing and raises review-failed', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })];
    const onComplete = vi.fn();
    const { events, implementer, options } = runOptions({
      projectDir,
      sessionId,
      state: resumedReviewState(tasks, head, 2),
      reviewText: CRITICAL_FAIL,
      onComplete,
    });

    const result = await runTasksAndReview(options);

    expect(events.find((e) => e.type === 'review_fix_started')).toBeUndefined();
    expect(implementer.retry).not.toHaveBeenCalled();
    expect(implementer.implement).not.toHaveBeenCalled();
    expect(result.completed).toBe(false);
    expect(result.state.reviewStatus).toBe('failed');
    expect(result.state.pendingRecovery?.reason).toBe('review-failed');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('a correction sent after the failed review repairs the owning brief once more and re-runs the review', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })];
    const failed = runOptions({
      projectDir,
      sessionId,
      state: resumedReviewState(tasks, head, 2),
      reviewText: CRITICAL_FAIL,
      onComplete: vi.fn(),
    });
    const halted = await runTasksAndReview(failed.options);
    expect(halted.state.pendingRecovery?.availableActions).toContain('revise');

    const { bus } = makeBusRecorder();
    const corrected = applyRecoveryAction({
      projectDir,
      sessionId,
      state: halted.state,
      action: 'revise',
      bus,
      comment: 'log the error, then rethrow it',
    });
    expect(corrected.ok).toBe(true);

    const onComplete = vi.fn();
    const { events, implementer, options } = runOptions({
      projectDir,
      sessionId,
      state: corrected.state,
      reviewText: '### Verdict\npass\n',
      onComplete,
    });
    const result = await runTasksAndReview(options);

    expect(implementer.retry).toHaveBeenCalledTimes(1);
    expect(implementer.retry).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('Operator correction: log the error, then rethrow it'),
      }),
    );
    expect(events.filter((e) => e.type === 'workflow_complete')).toEqual([
      expect.objectContaining({ review: 'passed' }),
    ]);
    expect(result.completed).toBe(true);
    expect(result.state.reviewStatus).toBe('passed');
    expect(result.state.reviewFixes?.cycle).toBe(3);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('a passing review still completes at persisted cycle 2', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })];
    const onComplete = vi.fn();
    const { options } = runOptions({
      projectDir,
      sessionId,
      state: resumedReviewState(tasks, head, 2),
      reviewText: '### Verdict\npass\n',
      onComplete,
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(true);
    expect(result.state.reviewStatus).toBe('passed');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('an abort during review keeps the budget across invocations: total repair starts never exceeds the cap', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' })];
    const controller = new AbortController();
    let reviewCalls = 0;
    const first = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, tasks.length),
      reviewText: () => {
        reviewCalls += 1;
        // The operator aborts while the second review call is in flight.
        if (reviewCalls === 2) controller.abort();
        return CRITICAL_FAIL;
      },
      onComplete: vi.fn(),
      signal: controller.signal,
    });

    const aborted = await runTasksAndReview(first.options);
    expect(aborted.completed).toBe(false);
    expect(aborted.cancelled).toBe(false);
    expect(aborted.state.phase).toBe('final-review');
    expect(aborted.state.reviewFixes?.cycle).toBe(1);

    const second = runOptions({
      projectDir,
      sessionId,
      state: aborted.state,
      reviewText: CRITICAL_FAIL,
      onComplete: vi.fn(),
    });

    const resumed = await runTasksAndReview(second.options);

    const fixCycles = [...first.events, ...second.events]
      .filter((e) => e.type === 'review_fix_started')
      .map((e) => e.cycle);
    expect(fixCycles).toEqual([1, 2]);
    expect(first.implementer.retry).toHaveBeenCalledTimes(1);
    expect(second.implementer.retry).toHaveBeenCalledTimes(1);
    expect(resumed.completed).toBe(false);
    expect(resumed.state.reviewStatus).toBe('failed');
    expect(resumed.state.reviewFixes?.cycle).toBe(2);
    expect(resumed.state.pendingRecovery?.reason).toBe('review-failed');
  });
});

describe('runTasksAndReview repair pause', { timeout: 120_000 }, () => {
  const repairedPair = (head: string): WorkflowState =>
    reviewedState(
      [
        makeTask({ id: 'T001', file: 'src/alpha.ts', status: 'done' }),
        makeTask({ id: 'T002', file: 'src/beta.ts', status: 'done' }),
      ],
      head,
      2,
    );

  it('parks a repair after the first fixed brief, keeps the next step and cycle, and continues the same repair in place', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const parks: { partial: string; at: string }[] = [];
    const continuation = { take: vi.fn(), hold: vi.fn() };
    const onComplete = vi.fn();
    const { events, implementer, options } = runOptions({
      projectDir,
      sessionId,
      state: repairedPair(head),
      reviewText: (call) => (call === 1 ? TWO_CRITICAL_FAIL : '### Verdict\npass\n'),
      onComplete,
      sinks: pauseOnceSinks(),
      onContinuationNeeded: async (partial, at) => {
        parks.push({ partial, at });
        return 'finish the remaining repair';
      },
      continuation,
    });

    const result = await runTasksAndReview(options);

    // The first review failed into a durable fix cycle before the park.
    const fixEvents = events.filter((e) => e.type === 'review_fix_started');
    expect(fixEvents).toHaveLength(1);
    expect(fixEvents[0]).toMatchObject({ cycle: 1, taskIds: ['T001', 'T002'] });

    // The persisted park: the brief it stopped before, with the spent cycle retained.
    const parkedStates = options.setTrackedState.mock.calls
      .map(([state]) => state as WorkflowState)
      .filter((s) => s.interruptedStep !== undefined);
    const parkedState = parkedStates[parkedStates.length - 1];
    expect(parkedState).toMatchObject({
      currentTaskIndex: 1,
      reviewFixes: { cycle: 1 },
      interruptedStep: {
        step: { kind: 'brief', taskId: 'T002', attempt: 0 },
        source: 'user',
        cut: 'boundary',
      },
    });
    expect(parks).toEqual([{ partial: '', at: 'boundary' }]);
    expect(events.find((e) => e.type === 'turn_interrupted')).toMatchObject({
      source: 'user',
      at: 'boundary',
    });

    // The operator continued: the park cleared and this process holds the steer
    // for the exact step the repair resumes at.
    expect(continuation.hold).toHaveBeenCalledWith(
      { kind: 'brief', taskId: 'T002', attempt: 0 },
      'finish the remaining repair',
    );

    // Each repaired brief ran exactly once, in order, across the park; repairs
    // stayed repairs.
    expect(vi.mocked(implementer.retry).mock.calls.map((call) => call[0].task.id)).toEqual([
      'T001',
      'T002',
    ]);
    expect(implementer.implement).not.toHaveBeenCalled();

    // The same repair finished: the re-review passed and no second cycle was charged.
    expect(result.completed).toBe(true);
    expect(result.state.reviewStatus).toBe('passed');
    expect(result.state.interruptedStep).toBeUndefined();
    expect(result.state.reviewFixes?.cycle).toBe(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('without a continuation callback the parked repair returns an open continuable run and repairs nothing twice', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const onComplete = vi.fn();
    const first = runOptions({
      projectDir,
      sessionId,
      state: repairedPair(head),
      reviewText: TWO_CRITICAL_FAIL,
      onComplete,
      sinks: pauseOnceSinks(),
    });

    const parked = await runTasksAndReview(first.options);

    // The park is durable: the run stands open at the boundary, picking up the
    // brief it stopped before.
    expect(parked.completed).toBe(false);
    expect(parked.cancelled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    expect(parked.state.interruptedStep).toMatchObject({
      step: { kind: 'brief', taskId: 'T002', attempt: 0 },
      source: 'user',
      cut: 'boundary',
    });
    expect(parked.state.awaitingContinue).toBe(true);
    expect(parked.state.reviewFixes?.cycle).toBe(1);
    expect(deriveRunStatus({ state: parked.state, liveness: 'not-alive' })).toMatchObject({
      kind: 'open',
      stop: { kind: 'paused', at: 'boundary' },
      resumeAt: { kind: 'brief', taskId: 'T002', attempt: 0 },
    });
    // Only the first fixed brief ran; the park charged no second cycle.
    expect(vi.mocked(first.implementer.retry).mock.calls.map((call) => call[0].task.id)).toEqual([
      'T001',
    ]);
    expect(first.events.filter((e) => e.type === 'review_fix_started')).toHaveLength(1);

    // The parked state continues where it stopped, in a later invocation.
    const second = runOptions({
      projectDir,
      sessionId,
      state: parked.state,
      reviewText: '### Verdict\npass\n',
      onComplete: vi.fn(),
    });
    const resumed = await runTasksAndReview(second.options);

    expect(vi.mocked(second.implementer.retry).mock.calls.map((call) => call[0].task.id)).toEqual([
      'T002',
    ]);
    expect(
      [...first.events, ...second.events].filter((e) => e.type === 'review_fix_started'),
    ).toHaveLength(1);
    expect(resumed.completed).toBe(true);
    expect(resumed.state.reviewStatus).toBe('passed');
  });

  it('an abort while parked keeps the repair continuable: the park stays, nothing else runs', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const controller = new AbortController();
    const onComplete = vi.fn();
    const { events, implementer, options } = runOptions({
      projectDir,
      sessionId,
      state: repairedPair(head),
      reviewText: TWO_CRITICAL_FAIL,
      onComplete,
      sinks: pauseOnceSinks(),
      signal: controller.signal,
      onContinuationNeeded: async () => {
        controller.abort();
        return '';
      },
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    expect(result.state.interruptedStep).toMatchObject({
      step: { kind: 'brief', taskId: 'T002', attempt: 0 },
      source: 'user',
      cut: 'boundary',
    });
    expect(result.state.awaitingContinue).toBe(true);
    expect(result.state.reviewFixes?.cycle).toBe(1);
    expect(deriveRunStatus({ state: result.state, liveness: 'not-alive' })).toMatchObject({
      kind: 'open',
      stop: { kind: 'paused', at: 'boundary' },
    });
    expect(vi.mocked(implementer.retry).mock.calls.map((call) => call[0].task.id)).toEqual([
      'T001',
    ]);
    expect(events.filter((e) => e.type === 'review_fix_started')).toHaveLength(1);
  });
});
