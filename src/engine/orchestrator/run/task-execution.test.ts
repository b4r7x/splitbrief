import { writeSpecFile } from '../../../core/paths-io.js';
import { writeConfig } from '../../../core/config/load/io.js';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import {
  failedReviewVerdict,
  passingReviewVerdict,
  planFromTasks,
  rejectingTriageResult,
  typedCallPlanReviewAndTriage,
} from '#testing/helpers/typed-planner.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { ReviewVerdict, TriageResult } from '../../../core/schemas/review.js';
import { taskId, type Task } from '../../../core/schemas/task.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import type { Validator } from '../validation/types.js';
import type {
  Implementer,
  ImplementerOptions,
  ImplementerResult,
  RetryOptions,
} from '../../implementers/types.js';
import { createContinuationHolder, type ContinuationHolder } from '../continuation.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { readEvidenceLedger, writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import { loadState } from '../../../core/state/persistence.js';
import { sessionDir } from '../../../core/paths.js';
import { readMessages } from '../../../core/sessions/log-reader.js';
import { listSnapshots, readManifest } from '../../snapshots/manifest.js';
import { createStdoutTextSink } from '../../events/sinks/stdout-text.js';
import { runTasksAndReview } from './task-execution.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import { createValidator } from '../validation/run.js';
import { formatRetryPrompt } from '../../spec/prompt-formatter.js';

/** How many times the session transcript holds this user turn. */
async function userTurns(ref: { projectDir: string; sessionId: string }, text: string) {
  let count = 0;
  for await (const message of readMessages(ref)) {
    if (message.role === 'user' && message.text === text) count += 1;
  }
  return count;
}

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
    fixCycles: { used: cycle, allowance: 2, notes: [] },
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
  review: ReviewVerdict | ((prompt: string, call: number) => ReviewVerdict);
  /** The triage answer; the default rejects every blocking finding. */
  triage?: ((prompt: string, call: number) => TriageResult | string) | undefined;
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
  const reviewPrompts: string[] = [];
  const triagePrompts: string[] = [];
  const reviewer = makePlanner({
    typedCall: typedCallPlanReviewAndTriage(
      () => planFromTasks(opts.state.tasks),
      (prompt, call) => {
        reviewPrompts.push(prompt);
        if (typeof opts.review === 'function') return opts.review(prompt, call);
        return opts.review;
      },
      (prompt, call) => {
        triagePrompts.push(prompt);
        return opts.triage === undefined
          ? rejectingTriageResult(prompt)
          : opts.triage(prompt, call);
      },
    ),
  });
  const implementer =
    opts.implementer ??
    makeImplementer({
      // Each brief writes the file it declared, so a run with more than one brief
      // does not read as an undeclared write.
      implement: vi.fn().mockImplementation(async (call: ImplementerOptions) => {
        const file = call.task.suggestedFiles[0];
        mkdirSync(join(call.projectDir, dirname(file)), { recursive: true });
        writeFileSync(join(call.projectDir, file), `export const value = ${Date.now()};\n`);
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
    triagePrompts,
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

describe('runTasksAndReview workspace', () => {
  it('the build start records the workspace once with its base snapshot', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const stop = new AbortController();
    stop.abort();
    const first = runOptions({
      projectDir,
      sessionId,
      state: reviewedState([], head, 0),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
      signal: stop.signal,
    });

    try {
      const result = await runTasksAndReview(first.options);
      const workspace = result.state.workspace;
      expect(workspace).toBeDefined();
      if (workspace === undefined) throw new Error('Missing recorded workspace');
      expect(loadState({ projectDir, sessionId })?.workspace).toEqual(workspace);
      expect(await readManifest(projectDir, sessionId, workspace.base.snapshotId)).toMatchObject({
        name: 'workspace-base',
        phase: 'manual',
      });
      const snapshots = await listSnapshots(projectDir, sessionId);
      expect(
        snapshots.manifests.filter((manifest) => manifest.name === 'workspace-base'),
      ).toHaveLength(1);
      expect(
        first.events
          .filter((event) => event.type === 'snapshot_created')
          .map((event) => event.name),
      ).toEqual(['run-baseline', 'workspace-base']);

      const continued = await runTasksAndReview({ ...first.options, state: result.state });
      expect(continued.state.workspace).toEqual(workspace);
      expect(await listSnapshots(projectDir, sessionId)).toEqual(snapshots);
      expect(first.events.filter((event) => event.type === 'snapshot_created')).toHaveLength(2);
    } finally {
      await first.options.wctx.isolation.dispose();
    }
  });

  it('a moved workspace halts the continued run', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const { options, implementer } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState([makeTask()], head, 0),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
    });
    try {
      const opened = await options.wctx.isolation.open({ config: options.wctx.config });
      const recordedPath = `${opened.projectDir}-gone`;
      const state: WorkflowState = {
        ...options.state,
        workspace: {
          kind: opened.kind,
          path: recordedPath,
          base: { snapshotId: 'baseline', head: opened.head },
        },
      };

      const continued = runTasksAndReview({ ...options, state });
      await expect(continued).rejects.toMatchObject({
        kind: 'run-workspace-moved',
        message: expect.stringContaining(recordedPath),
      });
      await expect(continued).rejects.toThrow(opened.projectDir);
      expect(implementer.implement).not.toHaveBeenCalled();
    } finally {
      await options.wctx.isolation.dispose();
    }
  });
});

describe('runTasksAndReview boundary pause', { timeout: 120_000 }, () => {
  it('parks between briefs, records the brief it stopped before, and continues into it', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'] }),
    ];
    const parks: { partial: string; at: string }[] = [];
    const { events, implementer, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 0),
      review: (prompt) => passingReviewVerdict(prompt),
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
    expect(events.filter((e) => e.type === 'workflow_resumed')).toEqual([
      expect.objectContaining({ phase: 'implementing' }),
    ]);
    // Both briefs ran: the park held the run between them rather than ending it.
    expect(implementer.implement).toHaveBeenCalledTimes(2);
    expect(result.completed).toBe(true);
    // The park was cleared when the operator continued.
    expect(result.state.interruptedStep).toBeUndefined();
  });

  // Run 2026-10-05-s6-central-checks-and-renders-plus-the-carried-in--3, 19:05 and 20:36: the
  // correction typed at "Paused after T001" reached T002's first prompt only, wrote no
  // user_message, and T006's retry prompt went out without it.
  it('a correction typed at the park holds for every attempt of the next brief and is recorded once', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'] }),
    ];
    const correction = 'Do not run any test, typecheck or lint command.';
    const steers: { call: 'implement' | 'retry'; taskId: string; steer: string | undefined }[] = [];
    const write = (call: ImplementerOptions): void => {
      const file = call.task.suggestedFiles[0];
      mkdirSync(join(call.projectDir, dirname(file)), { recursive: true });
      writeFileSync(join(call.projectDir, file), `export const value = ${Date.now()};\n`);
    };
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (call: ImplementerOptions) => {
        steers.push({ call: 'implement', taskId: call.task.id, steer: call.continuation?.steer });
        write(call);
        return { success: true, output: 'code' };
      }),
      retry: vi.fn().mockImplementation(async (call: RetryOptions) => {
        steers.push({ call: 'retry', taskId: call.task.id, steer: call.continuation?.steer });
        write(call);
        return { success: true, output: 'fixed' };
      }),
    });
    let t002Validations = 0;
    const { events, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 0),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
      sinks: pauseOnceSinks(),
      onContinuationNeeded: async () => correction,
      continuation: createContinuationHolder(),
      implementer,
      config: makeConfig({
        validation: { typecheck: true, lint: false, test: false, typecheckCommand: 'noop' },
      }),
      validator: {
        ...createValidator(),
        runValidation: vi.fn().mockImplementation(async ({ task }: { task: Task }) => {
          const onT002 = task.id === 'T002';
          if (onT002) t002Validations += 1;
          const failed = onT002 && t002Validations === 1;
          return [
            {
              stage: 'typecheck' as const,
              passed: !failed,
              error: failed ? 'TS2322 in src/beta.ts' : undefined,
              failureFiles: failed ? ['src/beta.ts'] : [],
            },
          ];
        }),
      },
    });

    const result = await runTasksAndReview(options);

    expect(steers.filter((entry) => entry.taskId === 'T001')).toEqual([
      { call: 'implement', taskId: 'T001', steer: undefined },
    ]);
    const onT002 = steers.filter((entry) => entry.taskId === 'T002');
    expect(onT002.map((entry) => entry.call)).toEqual(['implement', 'retry']);
    expect(onT002.map((entry) => entry.steer?.includes(correction) === true)).toEqual([true, true]);
    expect(
      events.filter((event) => event.type === 'user_message' && event.text === correction),
    ).toHaveLength(1);
    expect(await userTurns({ projectDir, sessionId }, correction)).toBe(1);
    expect(result.state.lineages?.T002?.corrections).toEqual([correction]);
    expect(loadState({ projectDir, sessionId })?.lineages?.T002?.corrections).toEqual([correction]);
  });

  it('a correction typed at a stop inside a brief holds for that brief retry too', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'] })];
    const correction = 'Keep the helper in src/alpha.ts.';
    let abortCall: (() => void) | null = null;
    const sinks: WorkflowSinks = {
      setAbortHandler: (handler) => {
        abortCall = handler;
      },
      setQueueHandler: () => {},
    };
    const steers: { call: 'implement' | 'retry'; steer: string | undefined }[] = [];
    let implementCalls = 0;
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (call: ImplementerOptions) => {
        implementCalls += 1;
        steers.push({ call: 'implement', steer: call.continuation?.steer });
        if (implementCalls === 1) {
          abortCall?.();
          throw new DOMException('The operation was aborted', 'AbortError');
        }
        mkdirSync(join(call.projectDir, 'src'), { recursive: true });
        writeFileSync(join(call.projectDir, 'src/alpha.ts'), 'export const a = 1;\n');
        return { success: true, output: 'code' };
      }),
      retry: vi.fn().mockImplementation(async (call: RetryOptions) => {
        steers.push({ call: 'retry', steer: call.continuation?.steer });
        writeFileSync(join(call.projectDir, 'src/alpha.ts'), 'export const a = 2;\n');
        return { success: true, output: 'fixed' };
      }),
    });
    let validations = 0;
    const { events, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 0),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
      sinks,
      onContinuationNeeded: async () => correction,
      continuation: createContinuationHolder(),
      implementer,
      config: makeConfig({
        validation: { typecheck: true, lint: false, test: false, typecheckCommand: 'noop' },
      }),
      validator: {
        ...createValidator(),
        runValidation: vi.fn().mockImplementation(async () => {
          validations += 1;
          const failed = validations === 1;
          return [
            {
              stage: 'typecheck' as const,
              passed: !failed,
              error: failed ? 'TS2322 in src/alpha.ts' : undefined,
              failureFiles: failed ? ['src/alpha.ts'] : [],
            },
          ];
        }),
      },
    });

    const result = await runTasksAndReview(options);

    expect(steers.map((entry) => entry.call)).toEqual(['implement', 'implement', 'retry']);
    expect(steers.map((entry) => entry.steer?.includes(correction) === true)).toEqual([
      false,
      true,
      true,
    ]);
    expect(
      events.filter((event) => event.type === 'user_message' && event.text === correction),
    ).toHaveLength(1);
    expect(await userTurns({ projectDir, sessionId }, correction)).toBe(1);
    expect(result.state.lineages?.T001?.corrections).toEqual([correction]);
  });

  it('records a boundary park and stops when nothing can continue the run in place', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'] }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'] }),
    ];
    const { implementer, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 0),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
      sinks: pauseOnceSinks(),
    });

    const result = await runTasksAndReview(options);

    expect(implementer.implement).toHaveBeenCalledTimes(1);
    expect(result.completed).toBe(false);
    expect(result.state.interruptedStep).toMatchObject({
      step: { kind: 'brief', taskId: 'T002', attempt: 0 },
      source: 'user',
      cut: 'boundary',
    });
  });
});

describe('runTasksAndReview', { timeout: 120_000 }, () => {
  function plannedState(tasks: Task[], head: string): WorkflowState {
    return {
      ...reviewedState(tasks, head, tasks.length),
      plan: {
        summary: 'Greet people by name',
        decisions: [],
        criteria: [{ id: 'C1', text: 'The greeting is returned', checkIds: ['K1'] }],
        checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
        validation: null,
      },
    };
  }

  it('a failing review triages once, appends its fix task and the next review passes', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const onComplete = vi.fn();
    let reviews = 0;
    const { events, implementer, triagePrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: plannedState(tasks, head),
      review: (prompt) => {
        reviews += 1;
        return reviews === 1
          ? failedReviewVerdict(prompt, 'src/shared/widget.ts drops the error', {
              taskId: 'T001',
              file: 'src/shared/widget.ts',
            })
          : passingReviewVerdict(prompt);
      },
      triage: () => ({
        fixTasks: [
          {
            ...makeTaskSpec({
              id: 'T002',
              suggestedFiles: ['src/shared/widget.ts'],
              checks: [{ id: 'K2', kind: 'cmd', value: 'node --version', required: true }],
            }),
            findingIds: ['F1'],
          },
        ],
        rejected: [],
        verify: [],
        ask: null,
      }),
      onComplete,
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(reviews).toBe(2);
    expect(triagePrompts).toHaveLength(1);
    const fixed = result.state.tasks[1];
    expect(fixed?.id).toBe('T002');
    expect(fixed?.batch).toBe(2);
    expect(fixed?.fix).toEqual({
      cycle: 1,
      findings: [
        {
          id: 'F1',
          text: 'src/shared/widget.ts drops the error',
          acceptance: null,
        },
      ],
    });
    // The fix task edits a file no task suggested, and the completed brief stays untouched.
    expect(fixed?.suggestedFiles[0]).toBe('src/shared/widget.ts');
    expect(result.state.tasks[0]?.status).toBe('done');
    expect(result.state.fixCycles?.used).toBe(1);
    expect(result.state.plannerCalls?.used).toBe(1);
    expect(events.find((e) => e.type === 'review_fix_started')).toMatchObject({
      cycle: 1,
      taskIds: ['T002'],
    });
    expect(vi.mocked(implementer.implement).mock.calls.map((call) => call[0].task.id)).toContain(
      'T002',
    );
  });

  it('spends a fix cycle even when the triage appends nothing, and halts at the cap', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const onComplete = vi.fn();
    const { events, implementer, triagePrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: plannedState(tasks, head),
      review: (prompt) =>
        failedReviewVerdict(prompt, 'src/alpha.ts drops the error', { taskId: 'T001' }),
      onComplete,
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    expect(triagePrompts).toHaveLength(2);
    expect(result.state.fixCycles).toEqual({ used: 2, allowance: 2, notes: [] });
    expect(result.state.reviewStatus).toBe('failed');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'review-failed',
      message: 'Final review failed after 2 fix cycles',
    });
    expect(result.state.pendingRecovery?.availableActions).toContain('accept-as-is');
    expect(events.find((e) => e.type === 'workflow_complete')).toMatchObject({
      review: 'failed',
      blocking: 1,
    });
    // Nothing was appended, so there is nothing to reopen and no cycle to announce.
    expect(events.find((e) => e.type === 'review_fix_started')).toBeUndefined();
    expect(implementer.retry).not.toHaveBeenCalled();
  });

  it('the cap halt names the spent cycles and offers the exits', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const { events, options, triagePrompts } = runOptions({
      projectDir,
      sessionId,
      state: resumedReviewState(tasks, head, 2),
      review: (prompt) =>
        failedReviewVerdict(prompt, 'src/alpha.ts still crashes', { taskId: 'T001' }),
      onComplete: vi.fn(),
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(false);
    expect(result.state.reviewStatus).toBe('failed');
    expect(result.state.phase).toBe('complete');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'review-failed',
      seat: 'build',
      message: 'Final review failed after 2 fix cycles',
    });
    expect(result.state.pendingRecovery?.availableActions).toEqual([
      'revise',
      'accept-as-is',
      'end-run',
    ]);
    expect(result.state.pendingRecovery?.recommendedAction).toBe('revise');
    expect(result.state.reviewedCandidate).toBeDefined();
    expect(triagePrompts).toHaveLength(0);
    expect(events.find((e) => e.type === 'error' && e.code === 'review_failed')).toBeDefined();
    expect(events.find((e) => e.type === 'workflow_complete')).toMatchObject({
      review: 'failed',
      blocking: 1,
    });
  });

  // A checkout run has nothing to apply: accepting the failed review as is records the override,
  // keeps the failed verdict and closes the run, as a passing review would.
  it('the cap halt of a checkout run offers accept as is, which closes the run on the failed verdict', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const { options } = runOptions({
      projectDir,
      sessionId,
      state: {
        ...resumedReviewState(tasks, head, 2),
        workspace: { kind: 'checkout', path: projectDir, base: { snapshotId: 'base', head } },
      },
      review: (prompt) =>
        failedReviewVerdict(prompt, 'src/alpha.ts still crashes', { taskId: 'T001' }),
      onComplete: vi.fn(),
      config: makeNoValidationConfig({ workflow: { isolation: 'none' } }),
    });

    const result = await runTasksAndReview(options);

    expect(result.state.pendingRecovery?.reason).toBe('review-failed');
    expect(result.state.pendingRecovery?.availableActions).toEqual([
      'revise',
      'accept-as-is',
      'end-run',
    ]);
    const accepted = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: result.state,
      action: 'accept-as-is',
      bus: makeBusRecorder().bus,
      comment: 'Ship it as is',
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.message);
    expect(accepted.state.reviewStatus).toBe('failed');
    expect(accepted.state.acceptedAsIs).toBeDefined();
    expect(deriveRunStatus({ state: accepted.state, liveness: 'not-alive' })).toEqual({
      kind: 'closed',
      as: 'complete',
    });
  });

  it('End run at the cap halt of a checkout run closes it as ended and writes no run.patch', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const { options, triagePrompts } = runOptions({
      projectDir,
      sessionId,
      state: {
        ...resumedReviewState(tasks, head, 2),
        workspace: { kind: 'checkout', path: projectDir, base: { snapshotId: 'base', head } },
      },
      review: (prompt) =>
        failedReviewVerdict(prompt, 'src/alpha.ts still crashes', { taskId: 'T001' }),
      onComplete: vi.fn(),
      config: makeNoValidationConfig({ workflow: { isolation: 'none' } }),
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(false);
    expect(result.state.reviewStatus).toBe('failed');
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'review-failed',
      seat: 'build',
      message: 'Final review failed after 2 fix cycles',
    });
    expect(triagePrompts).toHaveLength(0);

    const ended = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: result.state,
      action: 'end-run',
      bus: makeBusRecorder().bus,
    });
    expect(ended.ok).toBe(true);
    if (!ended.ok) throw new Error(ended.message);
    expect(ended.status).toBe('closed');
    expect(deriveRunStatus({ state: ended.state, liveness: 'not-alive' })).toEqual({
      kind: 'closed',
      as: 'ended',
    });
    expect(existsSync(join(sessionDir(projectDir, sessionId), 'run.patch'))).toBe(false);
  });

  it('a spent planner-call bound halts the triage on the plan seat', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const { options, triagePrompts } = runOptions({
      projectDir,
      sessionId,
      state: {
        ...plannedState(tasks, head),
        plannerCalls: { used: 10, allowance: 10 },
      },
      review: (prompt) =>
        failedReviewVerdict(prompt, 'src/alpha.ts drops the error', { taskId: 'T001' }),
      onComplete: vi.fn(),
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(false);
    expect(triagePrompts).toHaveLength(0);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'planner-calls-spent',
      message: 'The run used its planner-call allowance',
    });
    expect(result.state.pendingRecovery?.taskId).toBeUndefined();
    expect(result.state.pendingRecovery?.affectedTaskIds).toEqual([]);
  });

  it('a fail with only unverified criteria halts without a triage', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const { options, triagePrompts } = runOptions({
      projectDir,
      sessionId,
      state: {
        ...reviewedState(tasks, head, tasks.length),
        plan: {
          summary: 'Greet people by name',
          decisions: [],
          criteria: [{ id: 'C1', text: 'The rendered greeting is checked', checkIds: ['K1'] }],
          checks: [{ id: 'K1', kind: 'render', value: 'greeting-render', required: false }],
          validation: null,
        },
      },
      review: (prompt) => {
        const base = passingReviewVerdict(prompt);
        return {
          ...base,
          criteria: base.criteria.map((criterion) => ({ ...criterion, status: 'unverified' })),
        };
      },
      onComplete: vi.fn(),
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(false);
    expect(triagePrompts).toHaveLength(0);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'review-failed',
      message: 'Final review failed with 1 unverified criterion',
    });
    expect(result.state.pendingRecovery?.availableActions).toContain('revise');
  });

  it('a pending triage consumes the saved review without a new review call', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const { reviewPrompts, triagePrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: {
        ...resumedReviewState(tasks, head, 2),
        fixCycles: { used: 2, allowance: 3, notes: ['log the error, then rethrow it'] },
        reviewStatus: undefined,
        completedAt: undefined,
        pendingTriage: {
          inputs: [
            {
              id: 'U1',
              kind: 'defect',
              source: 'user',
              text: 'log the error, then rethrow it',
              file: null,
            },
          ],
        },
        review: {
          cycle: 2,
          verdict: {
            tasks: [{ id: taskId('T001'), plan: 'met', note: '' }],
            criteria: [{ id: 'C1', status: 'pass', evidence: '' }],
            findings: [],
          },
          outcome: 'fail',
          verification: [],
          at: '2026-10-04T10:00:00.000Z',
        },
      },
      review: (prompt) => passingReviewVerdict(prompt),
      triage: () => ({
        fixTasks: [
          {
            ...makeTaskSpec({ id: 'T002', suggestedFiles: ['src/shared/widget.ts'] }),
            criteria: [],
            checks: [],
            findingIds: ['U1'],
          },
        ],
        rejected: [],
        verify: [],
        ask: null,
      }),
      onComplete: vi.fn(),
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(true);
    // Only the review after the fix ran; the correction was judged by the triage alone.
    expect(reviewPrompts).toHaveLength(1);
    expect(triagePrompts).toHaveLength(1);
    expect(triagePrompts[0]).toContain('log the error, then rethrow it');
    expect(result.state.fixCycles?.used).toBe(3);
    expect(result.state.tasks[1]?.fix).toEqual({
      cycle: 3,
      findings: [{ id: 'U1', text: 'log the error, then rethrow it', acceptance: null }],
    });
    expect(result.state.tasks[0]?.status).toBe('done');
  });

  it('obtains a typed review before triaging a correction to an old Markdown-only review', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const old = {
      ...resumedReviewState(tasks, head, 2),
      phase: 'complete' as const,
      reviewStatus: 'failed' as const,
      reviewFixes: { cycle: 2, findings: { T001: ['Old Markdown defect'] } },
      pendingRecovery: buildReviewFailedRecoveryIssue({
        blocking: 1,
        fixCycles: 2,
        phase: 'complete',
        createdAt: '2026-10-04T00:00:00Z',
      }),
    };
    writeSpecFile(
      { projectDir, sessionId },
      'review.md',
      '### Verdict\nfail\n\n### Findings\n- **Critical**: Old Markdown defect',
    );
    const corrected = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: old,
      action: 'revise',
      bus: makeBusRecorder().bus,
      comment: 'Preserve the old session correction',
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error(corrected.message);
    const { reviewPrompts, triagePrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: corrected.state,
      review: (prompt) => passingReviewVerdict(prompt),
      triage: () => ({
        fixTasks: [],
        rejected: [{ findingId: 'U1', reason: 'The correction is satisfied' }],
        verify: [],
        ask: null,
      }),
      onComplete: vi.fn(),
    });
    const result = await runTasksAndReview(options);
    expect(result.completed).toBe(true);
    expect(reviewPrompts).toHaveLength(2);
    expect(triagePrompts).toHaveLength(1);
    expect(triagePrompts[0]).toContain('Preserve the old session correction');
    expect(result.state.tasks[0]).toEqual(tasks[0]);
    expect(result.state.fixCycles?.used).toBe(3);
  });

  it('a twice-invalid review halts with reviewer protocol recovery', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const { reviewPrompts, events, options } = runOptions({
      projectDir,
      sessionId,
      state: plannedState(tasks, head),
      review: (prompt) => ({ ...passingReviewVerdict(prompt), tasks: [] }),
      onComplete: vi.fn(),
    });
    const result = await runTasksAndReview(options);
    expect(result.completed).toBe(false);
    expect(reviewPrompts).toHaveLength(2);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'seat-protocol-error',
      seat: 'review',
    });
    expect(result.state.pendingRecovery?.availableActions).toContain('retry-same-worker');
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
  });

  it('a triage protocol error halts on the plan seat', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const { events, options } = runOptions({
      projectDir,
      sessionId,
      state: plannedState(tasks, head),
      review: (prompt) =>
        failedReviewVerdict(prompt, 'src/alpha.ts drops the error', { taskId: 'T001' }),
      triage: () => 'not the triage shape',
      onComplete: vi.fn(),
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(false);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'seat-protocol-error',
      seat: 'plan',
    });
    expect(events.find((e) => e.type === 'workflow_complete')).toBeUndefined();
  });

  it("closes a continued run with the run's completed briefs, not only the ones it ran", async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'] }),
    ];
    const { events, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 1),
      review: (prompt) => passingReviewVerdict(prompt),
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
  it('still escalates a brief that is not reopened when it changes nothing', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' }),
      makeTask({ id: 'T002', suggestedFiles: ['src/beta.ts'] }),
    ];
    const implementer = noChangeImplementer();
    const { events, options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 1),
      review: (prompt) => passingReviewVerdict(prompt),
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

/** A direct writer that writes its brief's file and records every retry prompt it is given. */
function promptRecordingImplementer(prompts: string[]): Implementer {
  const write = (task: Task, projectDir: string): void => {
    const file = task.suggestedFiles[0];
    mkdirSync(join(projectDir, dirname(file)), { recursive: true });
    writeFileSync(join(projectDir, file), `export const value = ${Date.now()};\n`);
  };
  return makeImplementer({
    implement: vi.fn().mockImplementation(async (call: ImplementerOptions) => {
      write(call.task, call.projectDir);
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
      write(call.task, call.projectDir);
      return { success: true, output: 'fixed' };
    }),
  });
}

describe('runTasksAndReview review fix instruction', { timeout: 120_000 }, () => {
  it('leaves the review instruction out of a retry after a validation failure', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'] })];
    const prompts: string[] = [];
    let validations = 0;
    const { options } = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, 0),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
      implementer: promptRecordingImplementer(prompts),
      config: makeConfig({
        validation: { typecheck: true, lint: false, test: false, typecheckCommand: 'noop' },
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
    expect(prompts[0]).not.toContain('These findings come from the final review.');
  });
});

describe('runTasksAndReview review halt', { timeout: 120_000 }, () => {
  it('hands the final review the run\u2019s skills context', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nREVIEW-SKILL-BODY';
    const { reviewPrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: resumedReviewState(tasks, head, 0),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
      skillsContext,
    });

    await runTasksAndReview(options);

    expect(reviewPrompts).toEqual([expect.stringContaining(skillsContext)]);
  });

  it('a correction after the failed review triages the saved review again and re-runs the review', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const failed = runOptions({
      projectDir,
      sessionId,
      state: resumedReviewState(tasks, head, 2),
      review: (prompt) =>
        failedReviewVerdict(prompt, 'src/alpha.ts drops the error', { taskId: 'T001' }),
      onComplete: vi.fn(),
    });
    const halted = await runTasksAndReview(failed.options);
    expect(halted.state.pendingRecovery?.availableActions).toContain('revise');
    expect(halted.state.review).toBeDefined();

    const { bus } = makeBusRecorder();
    const corrected = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: halted.state,
      action: 'revise',
      bus,
      comment: 'log the error, then rethrow it',
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.state.phase).toBe('final-review');
    expect(corrected.state.pendingTriage?.inputs[0]?.text).toBe('log the error, then rethrow it');

    const onComplete = vi.fn();
    const { events, implementer, triagePrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: corrected.state,
      review: (prompt) => passingReviewVerdict(prompt),
      triage: () => ({
        fixTasks: [
          {
            ...makeTaskSpec({
              id: 'T002',
              suggestedFiles: ['src/shared/widget.ts'],
              criteria: [],
              checks: [{ id: 'K2', kind: 'cmd', value: 'node --version', required: true }],
            }),
            findingIds: ['F1', 'U1'],
          },
        ],
        rejected: [],
        verify: [],
        ask: null,
      }),
      onComplete,
    });
    const result = await runTasksAndReview(options);

    // The correction reached the triage as an input; no completed brief was reopened.
    expect(triagePrompts).toHaveLength(1);
    expect(triagePrompts[0]).toContain('log the error, then rethrow it');
    expect(implementer.retry).not.toHaveBeenCalled();
    const fixed = result.state.tasks[1];
    expect(fixed?.fix?.cycle).toBe(3);
    expect(fixed?.fix?.findings.map((finding) => finding.id)).toEqual(['F1', 'U1']);
    expect(events.filter((e) => e.type === 'workflow_complete')).toEqual([
      expect.objectContaining({ review: 'passed' }),
    ]);
    expect(result.completed).toBe(true);
    expect(result.state.reviewStatus).toBe('passed');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('a passing review still completes at persisted cycle 2', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const onComplete = vi.fn();
    const { options } = runOptions({
      projectDir,
      sessionId,
      state: resumedReviewState(tasks, head, 2),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete,
    });

    const result = await runTasksAndReview(options);

    expect(result.completed).toBe(true);
    expect(result.state.reviewStatus).toBe('passed');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('an abort during review leaves the run on final-review for a retry', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const controller = new AbortController();
    const first = runOptions({
      projectDir,
      sessionId,
      state: reviewedState(tasks, head, tasks.length),
      review: (prompt) => {
        controller.abort();
        return passingReviewVerdict(prompt);
      },
      onComplete: vi.fn(),
      signal: controller.signal,
    });

    const aborted = await runTasksAndReview(first.options);
    expect(aborted.completed).toBe(false);
    expect(aborted.state.phase).toBe('final-review');

    const second = runOptions({
      projectDir,
      sessionId,
      state: aborted.state,
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
    });

    const resumed = await runTasksAndReview(second.options);
    expect(resumed.completed).toBe(true);
    expect(resumed.state.reviewStatus).toBe('passed');
  });
});

const MERGED_HUNK = '@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n';

/** A run Apply sent back to review because the merge changed the reviewed candidate. */
function integrationReviewState(tasks: Task[], head: string, cycle: number): WorkflowState {
  return {
    ...resumedReviewState(tasks, head, cycle),
    applyReview: { merged: [{ path: 'src/alpha.ts', checkoutHunks: MERGED_HUNK }], failures: [] },
  };
}

/** A ledger whose entries carry exactly the accepted changed files given. */
function ledgerFor(tasks: Task[], changed: Record<string, string[]>): EvidenceLedger {
  const ledger = createEvidenceLedger({ sessionId: 'sess-ledger', feature: 'feat', tasks });
  return {
    ...ledger,
    tasks: ledger.tasks.map((entry) => ({ ...entry, changedFiles: changed[entry.id] ?? [] })),
  };
}

describe('runTasksAndReview integration review', { timeout: 120_000 }, () => {
  it('halts every unrunnable required Apply check before triage or review, even with an optional failure', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [
      makeTask({
        id: 'T001',
        suggestedFiles: ['src/alpha.ts'],
        status: 'done',
        checks: [
          { id: 'K-task-refused', kind: 'cmd', value: 'npm run deploy', required: true },
          { id: 'K-optional-failure', kind: 'cmd', value: 'false', required: false },
        ],
      }),
    ];
    const state = {
      ...integrationReviewState(tasks, head, 0),
      plan: {
        summary: 'Re-check Apply',
        decisions: [],
        criteria: [],
        validation: null,
        checks: [
          { id: 'K-plan-refused', kind: 'cmd' as const, value: 'npx some-package', required: true },
          { id: 'K-render', kind: 'render' as const, value: 'overlay-picker', required: true },
        ],
      },
    };
    const { options, triagePrompts, reviewPrompts, implementer, events } = runOptions({
      projectDir,
      sessionId,
      state,
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
    });
    try {
      const result = await runTasksAndReview(options);

      expect(result.state.pendingRecovery?.reason).toBe('required-checks-unrunnable');
      for (const id of ['K-task-refused', 'K-plan-refused', 'K-render']) {
        expect(result.state.pendingRecovery?.message).toMatch(new RegExp(`${id}: \\S`));
      }
      expect(triagePrompts).toEqual([]);
      expect(reviewPrompts).toEqual([]);
      expect(implementer.implement).not.toHaveBeenCalled();
      expect(result.state.tasks).toHaveLength(1);
      expect(result.state.fixCycles?.used).toBe(0);
      expect(
        events.find(
          (event) => event.type === 'error' && event.code === 'required_checks_unrunnable',
        ),
      ).toBeDefined();
      expect(result.completed).toBe(false);
    } finally {
      await options.wctx.isolation.dispose();
    }
  });

  it('non-overlapping edit merges and the whole run diff is re-reviewed', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const { reviewPrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: integrationReviewState(tasks, head, 1),
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
    });

    try {
      const result = await runTasksAndReview(options);

      expect(reviewPrompts).toHaveLength(1);
      expect(reviewPrompts[0]).toContain('## Merged at Apply');
      expect(reviewPrompts[0]).toContain('src/alpha.ts');
      expect(reviewPrompts[0]).toContain(MERGED_HUNK);
      expect(result.state.reviewStatus).toBe('passed');
      expect(result.state.applyReview).toBeUndefined();
      expect(result.state.reviewedCandidate).toBeDefined();
      expect(deriveRunStatus({ state: result.state, liveness: 'not-alive' })).toEqual({
        kind: 'ready-to-apply',
        override: false,
      });
    } finally {
      await options.wctx.isolation.dispose();
    }
  });

  it('a changed candidate sends the fresh Apply failures to triage before the reviewer', async () => {
    const { projectDir, sessionId, head } = setupProject();
    writeFileSync(
      join(projectDir, 'Makefile'),
      'test:\n\t@echo "src/alpha.ts(1,1): error TS1005" >&2; exit 1\n',
    );
    const tasks = [
      makeTask({
        id: 'T001',
        suggestedFiles: ['src/alpha.ts'],
        status: 'done',
        checks: [{ id: 'C1', kind: 'cmd', value: 'make test', required: false }],
        checkResults: [{ id: 'C1', passed: true }],
      }),
    ];
    writeEvidenceLedger({ projectDir, sessionId }, ledgerFor(tasks, { T001: ['src/alpha.ts'] }));
    const controller = new AbortController();
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (call: ImplementerOptions) => {
        const file = call.task.suggestedFiles[0];
        mkdirSync(join(call.projectDir, dirname(file)), { recursive: true });
        writeFileSync(join(call.projectDir, file), 'export const value = 1;\n');
        controller.abort();
        return { success: true, output: 'code' };
      }),
    });
    const validator = createValidator();
    const runValidation = vi.spyOn(validator, 'runValidation');
    const { reviewPrompts, triagePrompts, options } = runOptions({
      projectDir,
      sessionId,
      state: {
        ...integrationReviewState(tasks, head, 2),
        plan: {
          summary: 'Re-check the merged candidate.',
          decisions: [],
          criteria: [],
          checks: [{ id: 'P1', kind: 'cmd', value: 'false', required: false }],
          validation: null,
        },
      },
      review: (prompt) => passingReviewVerdict(prompt),
      triage: () => ({
        fixTasks: [
          {
            ...makeTaskSpec({
              id: 'T002',
              suggestedFiles: ['src/alpha.ts'],
              criteria: [],
              checks: [],
            }),
            findingIds: ['A1', 'A2'],
          },
        ],
        rejected: [],
        verify: [],
        ask: null,
      }),
      onComplete: vi.fn(),
      validator,
      implementer,
      signal: controller.signal,
    });

    try {
      const result = await runTasksAndReview(options);

      const workspacePath = result.state.workspace?.path;
      expect(workspacePath).toBeDefined();
      expect(runValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectDir: workspacePath,
          task: expect.objectContaining({ id: 'T001' }),
        }),
      );
      // The re-check ran fresh: the recorded pass is overwritten by the merge's failure.
      expect(result.state.tasks[0]?.checkResults).toEqual([{ id: 'C1', passed: false }]);
      expect(reviewPrompts).toHaveLength(0);
      expect(triagePrompts).toHaveLength(1);
      expect(triagePrompts[0]).toContain('C1');
      expect(triagePrompts[0]).toContain('src/alpha.ts');
      expect(triagePrompts[0]).toContain('Last changed by T001.');
      expect(triagePrompts[0]).toContain('No task changed it.');
      expect(result.completed).toBe(false);
    } finally {
      await options.wctx.isolation.dispose();
    }
  });
});

describe('runTasksAndReview required-checks halt retry', { timeout: 120_000 }, () => {
  it('a render command saved after the halt reaches the retried pre-review, whose render check runs before the review', async () => {
    const { projectDir, sessionId, head } = setupProject();
    const tasks = [makeTask({ id: 'T001', suggestedFiles: ['src/alpha.ts'], status: 'done' })];
    const state = {
      ...reviewedState(tasks, head, tasks.length),
      plan: {
        summary: 'Render the picker',
        decisions: [],
        criteria: [],
        validation: null,
        checks: [
          { id: 'K-render', kind: 'render' as const, value: 'overlay-picker', required: true },
        ],
      },
    };
    const stale = makeNoValidationConfig({ workflow: {} });
    const halted = runOptions({
      projectDir,
      sessionId,
      state,
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
      config: stale,
    });
    let haltedState: WorkflowState;
    try {
      const first = await runTasksAndReview(halted.options);
      expect(first.state.pendingRecovery?.reason).toBe('required-checks-unrunnable');
      expect(halted.reviewPrompts).toEqual([]);
      haltedState = first.state;
    } finally {
      await halted.options.wctx.isolation.dispose();
    }

    writeConfig(
      projectDir,
      makeNoValidationConfig({ workflow: {}, validation: { render: 'true {id} {out}' } }),
    );
    const retried = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: haltedState,
      action: 'retry-same-worker',
      bus: halted.options.wctx.bus,
      config: stale,
    });
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.currentConfig?.validation.render).toBe('true {id} {out}');

    const resumed = runOptions({
      projectDir,
      sessionId,
      state: retried.state,
      review: (prompt) => passingReviewVerdict(prompt),
      onComplete: vi.fn(),
      config: retried.currentConfig ?? stale,
    });
    try {
      const second = await runTasksAndReview(resumed.options);
      expect(second.state.pendingRecovery).toBeUndefined();
      expect(resumed.reviewPrompts).toHaveLength(1);
      expect(second.completed).toBe(true);
      const renders = (readEvidenceLedger({ projectDir, sessionId })?.tasks ?? []).flatMap(
        (entry) => (entry.checks ?? []).filter((check) => check.id === 'K-render'),
      );
      // The halt's run left no exit code; the retried pre-review ran the command.
      expect(renders.map((check) => check.exitCode)).toEqual([undefined, 0]);
    } finally {
      await resumed.options.wctx.isolation.dispose();
    }
  });
});
