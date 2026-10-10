import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeCopyingIsolation,
  makeBusRecorder,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import {
  failedReviewVerdict,
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import { REVIEW_FILE, SPEC_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { createEvidenceLedger } from '../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { createInitialState } from '../../core/state/machine.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { allowedActionsForHalt, haltOf } from '../../core/recovery/halt.js';
import { RecoveryIssueSchema, type RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { deriveRunStatus } from '../../core/sessions/run-status.js';
import type { Config } from '../../core/schemas/config.js';
import type { ReviewVerdict } from '../../core/schemas/review.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { defaultCliAuthChannel } from '../../core/runners/cli-tool-catalog.js';
import { error } from '../../utils/error.js';
import type { EngineEvent } from '../events/types.js';
import type { ApiContextDiagnostic } from '../providers/api-context-diagnostic.js';
import { runPlanningSession } from './planning/session.js';
import { applyRecoveryAction } from './recovery/actions.js';
import { MAX_SUMMARY_LENGTH } from './recovery/builders/issue.js';
import { buildPlannerCallFailedRecoveryIssue } from './recovery/builders/planner.js';
import { buildReviewFailedRecoveryIssue } from './recovery/builders/task.js';
import { runTasksAndReview } from './run/task-execution.js';

const universe = vi.hoisted(() => ({ fullDiff: '', changedFiles: [] as string[] }));
const drift = vi.hoisted(() => ({ fails: false }));
const taskLoop = vi.hoisted(() => ({ calls: 0 }));

// The run universe is git's answer. Nothing in this suite may touch a
// repository, so the diff and the changed files are supplied directly.
vi.mock('./evidence/review-packet/sections-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./evidence/review-packet/sections-io.js')>();
  return {
    ...actual,
    resolveRunUniverse: async () => ({
      fullDiff: universe.fullDiff,
      changedFiles: [...universe.changedFiles],
    }),
  };
});

vi.mock('./drift/analyze.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./drift/analyze.js')>();
  return {
    ...actual,
    analyzeBriefDrift: (input: Parameters<typeof actual.analyzeBriefDrift>[0]) => {
      if (drift.fails) throw new Error('the ledger and the universe disagree');
      return actual.analyzeBriefDrift(input);
    },
  };
});

// Implementation is another card's subject: the briefs are settled before this
// suite starts, and what matters here is whether the review reopens any of them.
vi.mock('./task/loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./task/loop.js')>();
  return {
    ...actual,
    runTaskLoop: async (opts: Parameters<typeof actual.runTaskLoop>[0]) => {
      taskLoop.calls += 1;
      return { state: opts.initialState, taskBreakdowns: [], status: 'complete' as const };
    },
  };
});

const CREATED_AT = '2026-09-17T09:00:00.000Z';

const SUMMARY_BASE = {
  feature: 'Add a login route',
  startTime: Date.now() - 1_000,
  plannerTool: 'ollama',
  implementerTool: 'ollama',
};

/** Figures no wording could produce by accident, so prose can be checked for them. */
const ESTIMATES = {
  inputEstimate: 123_457,
  estimationMargin: 30_011,
  requiredOutputTokens: 20_483,
  requiredTokens: 987_653,
  availableTokens: 61_949,
  outputCap: 40_961,
} as const;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  universe.fullDiff = '';
  universe.changedFiles = [];
  drift.fails = false;
  taskLoop.calls = 0;
});

function setupSession(name: string): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir(name);
  dirs.push(projectDir);
  const sessionId = `sess-${name}`;
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function diagnostic(overrides: Partial<ApiContextDiagnostic> = {}): ApiContextDiagnostic {
  return {
    code: 'insufficient-context',
    seat: 'plan',
    cause: 'missing-required',
    missingSections: ['spec.md'],
    model: 'qwen2.5',
    ...overrides,
  };
}

function factString(issue: RecoveryIssue | undefined, key: string): string {
  const value = issue?.facts?.[key];
  return typeof value === 'string' ? value : '';
}

describe('a PLAN packet the seat was never given', () => {
  // A seat that reads no files of its own, on a model with room to spare: what refuses the packet
  // is the evidence the request promises and the project does not have.
  async function plan(ref: { projectDir: string; sessionId: string }, feature: string) {
    const planner = makePlanner({
      resolvePlanningContext: async () => ({
        contextKey: 'ollama@local',
        selectionId: 'qwen2.5',
        observedAt: 0,
        applicationContextTokens: 64_000,
        budgetSource: 'configured',
        loadState: 'unknown',
      }),
    });
    const state: WorkflowState = createInitialState(feature);
    saveState(ref, state);
    const wctx = makeWctx({ ...ref, planner, reviewer: planner });

    const result = await runPlanningSession({ wctx, planner, state, feature });

    if (result.disposition !== 'terminal') throw new Error('expected a terminal planning result');
    expect(result.outcome).toBe('halted');
    return { state: result.state, issue: result.state.pendingRecovery, planner };
  }

  it('halts on the plan seat before the first call, with the cause and the sections kept', async () => {
    const ref = setupSession('plan-context');
    const missingSections = ['src/login.ts', 'src/session.ts'];

    const { state, issue, planner } = await plan(
      ref,
      'Modify `src/login.ts` and update `src/session.ts` to add a login route.',
    );

    expect(planner.typedCall).not.toHaveBeenCalled();
    expect(state.phase).toBe('planning');
    expect(issue?.reason).toBe('planner-call-failed');
    expect(issue?.seat).toBe('plan');
    expect(issue?.taskId).toBeUndefined();
    expect(issue?.facts?.apiContextCode).toBe('insufficient-context');
    expect(issue?.facts?.apiContextSeat).toBe('plan');
    expect(issue?.facts?.apiContextCause).toBe('missing-required');
    expect(JSON.parse(factString(issue, 'apiContextMissingSectionsJson'))).toEqual(missingSections);
    // There is no brief here to skip or repair: the seat runs again or it does not.
    expect(issue?.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(loadState(ref)?.pendingRecovery?.reason).toBe('planner-call-failed');
  });

  it('reads the diagnosis off the error data, not off wording that reads like a quota', async () => {
    const ref = setupSession('plan-quota-lookalike');

    // A project that names a fixture after the error it replays would otherwise
    // be told to wait for a limit to reset and to keep its planner seat.
    const { issue } = await plan(
      ref,
      'Update `fixtures/insufficient_quota.json` for the login route.',
    );

    expect(JSON.parse(factString(issue, 'apiContextMissingSectionsJson'))).toEqual([
      'fixtures/insufficient_quota.json',
    ]);
    expect(issue?.reason).toBe('planner-call-failed');
    expect(issue?.resetAt).toBeUndefined();
    expect(issue?.message).not.toContain('usage limit');
    expect(issue?.message.toLowerCase()).not.toContain('log in');
  });
});

/** A reviewer seat on its own local endpoint. No call ever reaches it. */
function apiReviewerConfig(contextLength = 64_000): Config {
  return makeNoValidationConfig({
    reviewer: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5',
      contextLength,
    },
  });
}

function setupRun(
  name: string,
  opts: { ledger: boolean },
): { projectDir: string; sessionId: string } {
  const ref = setupSession(name);
  writeSpecFile(ref, SPEC_FILE, '# Spec\n\nAdd a login route.\n', null);
  writeSpecFile(ref, TASKS_FILE, '## T001 — login route\n\nWrite it.\n', null);
  if (opts.ledger) {
    writeEvidenceLedger(
      ref,
      createEvidenceLedger({
        sessionId: ref.sessionId,
        feature: 'Add a login route',
        tasks: [makeTask({ id: 'T001', status: 'done' })],
      }),
    );
  }
  return ref;
}

function diffOfLength(path: string, chars: number): string {
  const head = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1 @@\n+`;
  return head + 'x'.repeat(chars - head.length);
}

const PASS_REVIEW = (prompt: string): ReviewVerdict => passingReviewVerdict(prompt);
const CRITICAL_REVIEW = (prompt: string): ReviewVerdict =>
  failedReviewVerdict(prompt, 'src/login.ts leaks the token', { taskId: 'T001' });

async function review(opts: {
  ref: { projectDir: string; sessionId: string };
  config: Config;
  reviews?: Array<(prompt: string) => ReviewVerdict | string> | undefined;
  throws?: unknown;
  cycle?: number | undefined;
}): Promise<{
  result: Awaited<ReturnType<typeof runTasksAndReview>>;
  events: EngineEvent[];
  reviewCalls: number;
  implementer: ReturnType<typeof makeImplementer>;
}> {
  const { ref } = opts;
  const { bus, events } = makeBusRecorder();
  let reviewCalls = 0;
  const reviewer = makePlanner({
    typedCall: typedCallPlanAndReview(
      () => planFromTasks([]),
      (prompt) => {
        reviewCalls += 1;
        if (opts.throws !== undefined) throw opts.throws;
        const replies = opts.reviews ?? [PASS_REVIEW];
        const reply = replies[Math.min(reviewCalls - 1, replies.length - 1)] ?? PASS_REVIEW;
        return reply(prompt);
      },
    ),
  });
  const implementer = makeImplementer();
  const tasks: Task[] = [
    makeTask({ id: 'T001', suggestedFiles: ['src/login.ts'], status: 'done' }),
  ];
  const base: WorkflowState = {
    ...makeImplState(tasks),
    phase: 'final-review',
    currentTaskIndex: tasks.length,
    changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
    ...(opts.cycle !== undefined && { reviewFixes: { cycle: opts.cycle, findings: {} } }),
  };
  saveState(ref, base);
  const state = loadState(ref);
  if (state === null) throw new Error('expected the run state to persist');
  const wctx = makeWctx({
    ...ref,
    isolation: makeCopyingIsolation({ projectDir: ref.projectDir, sessionId: ref.sessionId }),
    config: opts.config,
    bus,
    planner: reviewer,
    reviewer,
    implementer,
  });

  const result = await runTasksAndReview({
    wctx,
    state,
    planning: { disposition: 'ready-for-tasks', state, tasks },
    summaryBase: SUMMARY_BASE,
    phaseTimings: {},
    setTrackedState: () => {},
    setCurrentTask: () => {},
  });
  return { result, events, reviewCalls, implementer };
}

describe('a REVIEW that reached no verdict', () => {
  it('halts on the review seat with no blocker count and no completion', async () => {
    const ref = setupRun('review-budget', { ledger: true });
    universe.fullDiff = diffOfLength('src/login.ts', 100_001);
    universe.changedFiles = ['src/login.ts'];

    const { result, events, reviewCalls } = await review({
      ref,
      config: apiReviewerConfig(10_000),
    });

    expect(reviewCalls).toBe(0);
    expect(result.completed).toBe(false);
    // Nothing was judged, so nothing settles: the phase, the briefs and the
    // repair budget are exactly where the review found them.
    expect(result.state.phase).toBe('final-review');
    expect(result.state.reviewStatus).toBeUndefined();
    expect(result.state.reviewFixes).toBeUndefined();
    expect(result.state.tasks.map((task) => task.status)).toEqual(['done']);
    expect(taskLoop.calls).toBe(1);
    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), REVIEW_FILE))).toBe(false);

    const issue = result.state.pendingRecovery;
    expect(issue?.reason).toBe('review-failed');
    expect(issue?.seat).toBe('review');
    expect(issue?.taskId).toBeUndefined();
    expect(issue?.facts?.blocking).toBeUndefined();
    expect(issue?.facts?.apiContextCause).toBe('input-budget');
    expect(issue?.facts?.reviewFailureKind).toBe('insufficient-context');
    expect(issue?.availableActions).toContain('retry-same-worker');

    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
    expect(events.find((event) => event.type === 'review_fix_started')).toBeUndefined();
    const failed = events.find((event) => event.type === 'error' && event.code === 'review_failed');
    expect(failed).toBeDefined();
    expect(JSON.stringify(failed)).not.toContain('0 blocking');
    expect(deriveRunStatus({ state: result.state, liveness: 'not-alive' }).kind).toBe('open');
  });

  it('refuses a packet missing its recorded evidence rather than reviewing what is left', async () => {
    const ref = setupRun('review-evidence', { ledger: false });
    universe.fullDiff = diffOfLength('src/login.ts', 400);
    universe.changedFiles = ['src/login.ts'];

    const { result, reviewCalls } = await review({ ref, config: apiReviewerConfig() });

    expect(reviewCalls).toBe(0);
    const issue = result.state.pendingRecovery;
    expect(issue?.seat).toBe('review');
    expect(issue?.facts?.apiContextCause).toBe('missing-required');
    expect(JSON.parse(factString(issue, 'apiContextMissingSectionsJson'))).toEqual([
      'evidence.json',
    ]);
    expect(result.state.phase).toBe('final-review');
  });

  it('recomputes a drift report it never had, and refuses when it cannot', async () => {
    const recomputed = setupRun('review-drift-ok', { ledger: true });
    universe.fullDiff = diffOfLength('src/login.ts', 400);
    universe.changedFiles = ['src/login.ts'];

    const accepted = await review({ ref: recomputed, config: apiReviewerConfig() });

    expect(accepted.reviewCalls).toBe(1);
    expect(accepted.result.completed).toBe(true);
    expect(accepted.result.state.pendingRecovery).toBeUndefined();

    const unreconstructable = setupRun('review-drift-refused', { ledger: true });
    drift.fails = true;

    const refused = await review({ ref: unreconstructable, config: apiReviewerConfig() });

    expect(refused.reviewCalls).toBe(0);
    expect(
      JSON.parse(factString(refused.result.state.pendingRecovery, 'apiContextMissingSectionsJson')),
    ).toEqual(['drift-report.json']);
  });

  it('carries a transport failure as a call that did not land, not as zero blockers', async () => {
    const ref = setupRun('review-transport', { ledger: true });

    const { result, events } = await review({
      ref,
      config: makeNoValidationConfig(),
      throws: new Error('socket hang up'),
    });

    const issue = result.state.pendingRecovery;
    expect(issue?.reason).toBe('review-failed');
    expect(issue?.seat).toBe('review');
    expect(issue?.facts?.reviewFailureKind).toBe('call-failed');
    expect(issue?.facts?.blocking).toBeUndefined();
    expect(issue?.message).toContain('socket hang up');
    expect(issue?.recommendedAction).toBe('retry-same-worker');
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
  });

  it('halts on the review seat with a protocol error when a reply names no verdict twice', async () => {
    const ref = setupRun('review-unparseable', { ledger: true });

    const { result, reviewCalls } = await review({
      ref,
      config: makeNoValidationConfig(),
      reviews: [() => '### Summary\nIt is fine, I suppose.\n'],
    });

    // The reviewer gets its one repair before the run gives up on the verdict.
    expect(reviewCalls).toBe(2);
    expect(result.state.pendingRecovery?.seat).toBe('review');
    expect(result.state.pendingRecovery?.reason).toBe('seat-protocol-error');
    expect(result.state.pendingRecovery?.facts?.blocking).toBeUndefined();
    expect(result.state.phase).toBe('final-review');
  });
});

describe('a REVIEW that reached a verdict', () => {
  it('keeps a fail on the build seat, with its count, a correction, accept as is and the end', async () => {
    const ref = setupRun('review-substantive', { ledger: true });

    const { result, events } = await review({
      ref,
      config: makeNoValidationConfig(),
      reviews: [CRITICAL_REVIEW],
      cycle: 2,
    });

    const issue = result.state.pendingRecovery;
    expect(issue?.reason).toBe('review-failed');
    expect(issue?.seat).toBe('build');
    expect(issue?.facts?.blocking).toBe(1);
    expect(issue?.availableActions).toEqual(['revise', 'accept-as-is', 'end-run']);
    expect(issue?.recommendedAction).toBe('revise');
    expect(result.state.phase).toBe('complete');
    expect(result.state.reviewStatus).toBe('failed');
    expect(events.find((event) => event.type === 'workflow_complete')).toMatchObject({
      review: 'failed',
      blocking: 1,
    });
  });
});

describe('the diagnosis a halt persists', () => {
  const missingSections = Array.from(
    { length: 24 },
    (_, index) => `packages/service/src/fixtures/required-source-${index}.ts`,
  );
  const full = diagnostic({ seat: 'review', missingSections, ...ESTIMATES });

  it('keeps every missing section in facts although the rendered detail truncates', () => {
    const issue = buildReviewFailedRecoveryIssue({
      failure: { kind: 'insufficient-context', diagnostic: full },
      createdAt: CREATED_AT,
    });

    const detail = issue.details.find((line) => line.startsWith('Missing: '));
    expect(detail).toHaveLength(MAX_SUMMARY_LENGTH);
    expect(detail?.endsWith('...')).toBe(true);
    expect(JSON.parse(factString(issue, 'apiContextMissingSectionsJson'))).toEqual(missingSections);

    const roundTripped = RecoveryIssueSchema.parse(JSON.parse(JSON.stringify(issue)));
    expect(roundTripped).toEqual(issue);
    expect(roundTripped.facts).toEqual({
      reviewFailureKind: 'insufficient-context',
      apiContextCode: 'insufficient-context',
      apiContextSeat: 'review',
      apiContextCause: 'missing-required',
      apiContextModel: 'qwen2.5',
      apiContextMissingSectionsJson: JSON.stringify(missingSections),
      apiContextInputEstimate: ESTIMATES.inputEstimate,
      apiContextEstimationMargin: ESTIMATES.estimationMargin,
      apiContextRequiredOutputTokens: ESTIMATES.requiredOutputTokens,
      apiContextRequiredTokens: ESTIMATES.requiredTokens,
      apiContextAvailableTokens: ESTIMATES.availableTokens,
      apiContextOutputCap: ESTIMATES.outputCap,
    });
  });

  it('keeps every estimate out of the prose the panel renders, on both seats', () => {
    const issues = [
      buildReviewFailedRecoveryIssue({
        failure: { kind: 'insufficient-context', diagnostic: full },
        createdAt: CREATED_AT,
      }),
      buildPlannerCallFailedRecoveryIssue({
        diagnosis: { failure: 'call-failed', message: 'Planning failed.' },
        phase: 'planning',
        runner: makeNoValidationConfig().planner,
        details: ['Missing: spec.md'],
        facts: {
          apiContextCode: 'insufficient-context',
          apiContextInputEstimate: ESTIMATES.inputEstimate,
          apiContextAvailableTokens: ESTIMATES.availableTokens,
        },
        createdAt: CREATED_AT,
      }),
    ];

    for (const issue of issues) {
      const prose = [issue.message, ...issue.details].join('\n');
      for (const figure of Object.values(ESTIMATES)) {
        expect(prose).not.toContain(String(figure));
      }
      // The worker line renders this one by default; the diagnosis never uses it.
      expect(issue.facts?.contextLength).toBeUndefined();
      expect(RecoveryIssueSchema.parse(JSON.parse(JSON.stringify(issue)))).toEqual(issue);
      expect(issue.details.every((line) => line.length <= MAX_SUMMARY_LENGTH)).toBe(true);
    }
  });
});

describe('answering a halt that names no brief', () => {
  const config = makeNoValidationConfig();

  function halted(
    name: string,
    issue: RecoveryIssue,
    open?: { tasks: Task[]; phase: WorkflowState['phase']; currentTaskIndex: number },
  ): { ref: { projectDir: string; sessionId: string }; state: WorkflowState } {
    const ref = setupSession(name);
    const at = open ?? {
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      phase: 'final-review' as const,
      currentTaskIndex: 1,
    };
    saveState(ref, {
      ...makeImplState(at.tasks),
      phase: at.phase,
      currentTaskIndex: at.currentTaskIndex,
      pendingRecovery: issue,
    });
    const state = loadState(ref);
    if (state === null) throw new Error('expected the halt to persist');
    return { ref, state };
  }

  function contextIssue(seat: 'plan' | 'review'): RecoveryIssue {
    return seat === 'review'
      ? buildReviewFailedRecoveryIssue({
          failure: { kind: 'insufficient-context', diagnostic: diagnostic({ seat: 'review' }) },
          createdAt: CREATED_AT,
        })
      : buildPlannerCallFailedRecoveryIssue({
          diagnosis: { failure: 'call-failed', message: 'Planning failed.' },
          phase: 'planning',
          runner: config.planner,
          facts: { apiContextCode: 'insufficient-context', apiContextSeat: 'plan' },
          createdAt: CREATED_AT,
        });
  }

  it('clears a review-seat halt on the retry without resetting a brief', async () => {
    const { ref, state } = halted('retry-review-seat', contextIssue('review'));
    const { bus, events } = makeBusRecorder();

    const retried = await applyRecoveryAction({
      ...ref,
      state,
      action: 'retry-same-worker',
      bus,
      config,
    });

    expect(retried).toMatchObject({ ok: true, status: 'continued' });
    expect(retried.state.pendingRecovery).toBeUndefined();
    expect(retried.state.tasks.map((task) => task.status)).toEqual(['done']);
    expect(retried.state.currentTaskIndex).toBe(1);
    expect(events.some((event) => event.type === 'task_reset')).toBe(false);
    expect(loadState(ref)?.pendingRecovery).toBeUndefined();
  });

  it('clears a plan-seat halt the same way', async () => {
    const { ref, state } = halted('retry-plan-seat', contextIssue('plan'));
    const { bus, events } = makeBusRecorder();

    const retried = await applyRecoveryAction({
      ...ref,
      state,
      action: 'retry-same-worker',
      bus,
      config,
    });

    expect(retried).toMatchObject({ ok: true, status: 'continued' });
    expect(retried.state.pendingRecovery).toBeUndefined();
    expect(events.some((event) => event.type === 'task_reset')).toBe(false);
  });

  it('clears a review call that did not land the same way', async () => {
    const issue = buildReviewFailedRecoveryIssue({
      failure: { kind: 'call-failed', code: 'review-unavailable', message: 'socket hang up' },
      createdAt: CREATED_AT,
    });
    const { ref, state } = halted('retry-review-call', issue);
    const { bus, events } = makeBusRecorder();

    const retried = await applyRecoveryAction({
      ...ref,
      state,
      action: 'retry-same-worker',
      bus,
      config,
    });

    expect(retried).toMatchObject({ ok: true, status: 'continued' });
    expect(events.some((event) => event.type === 'task_reset')).toBe(false);
  });

  it('refuses the retry a substantive review failure never offered', async () => {
    const issue = buildReviewFailedRecoveryIssue({ blocking: 2, createdAt: CREATED_AT });
    const { ref, state } = halted('retry-substantive', issue);
    const { bus } = makeBusRecorder();

    const blocked = await applyRecoveryAction({
      ...ref,
      state,
      action: 'retry-same-worker',
      bus,
      config,
    });

    expect(blocked).toMatchObject({ ok: false, code: 'action-not-available' });
    expect(blocked.state.pendingRecovery?.reason).toBe('review-failed');
    // The halt admits the action; only a non-verdict failure is offered it.
    expect(allowedActionsForHalt(haltOf('review-failed'))).toContain('retry-same-worker');
  });

  it('still replays the brief when the halt names one', async () => {
    const task = makeTask({ id: 'T001', status: 'in_progress' });
    const seatless = contextIssue('review');
    const issue: RecoveryIssue = { ...seatless, taskId: task.id, taskTitle: task.title };
    const { ref, state } = halted('retry-named-brief', issue, {
      tasks: [task],
      phase: 'implementing',
      currentTaskIndex: 0,
    });
    const { bus, events } = makeBusRecorder();

    const retried = await applyRecoveryAction({
      ...ref,
      state,
      action: 'retry-same-worker',
      bus,
      config,
    });

    expect(retried).toMatchObject({ ok: true, status: 'retry-current-task' });
    expect(events.some((event) => event.type === 'task_reset')).toBe(true);
  });
});

describe('a corrected review seat', () => {
  it('passes the same run without reimplementing a settled brief', async () => {
    const ref = setupRun('review-corrected', { ledger: true });
    universe.fullDiff = diffOfLength('src/login.ts', 100_001);
    universe.changedFiles = ['src/login.ts'];

    const refused = await review({ ref, config: apiReviewerConfig(10_000) });
    expect(refused.result.state.pendingRecovery?.seat).toBe('review');

    const { bus } = makeBusRecorder();
    const cleared = await applyRecoveryAction({
      ...ref,
      state: refused.result.state,
      action: 'retry-same-worker',
      bus,
      config: apiReviewerConfig(10_000),
    });
    expect(cleared).toMatchObject({ ok: true, status: 'continued' });

    // Same packet, a seat that can hold it: the run re-enters the same phase.
    const passed = await review({ ref, config: apiReviewerConfig(200_000) });

    expect(passed.reviewCalls).toBe(1);
    expect(passed.result.completed).toBe(true);
    expect(passed.result.state.pendingRecovery).toBeUndefined();
    expect(passed.result.state.tasks.map((task) => task.status)).toEqual(['done']);
    expect(passed.implementer.implement).not.toHaveBeenCalled();
    expect(passed.implementer.retry).not.toHaveBeenCalled();
  });
});

// Captured from `codex exec --json` against an account at its usage limit; the review call wraps
// it the way `requireCompletedCall` does.
const CODEX_LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 1:02 PM.";

const CODEX_SEAT = {
  kind: 'cli',
  tool: 'codex',
  authChannel: defaultCliAuthChannel('codex').id,
} as const;

describe('a REVIEW seat out of quota', () => {
  const followsPlan = makeNoValidationConfig({ planner: CODEX_SEAT });
  const ownSeat = makeNoValidationConfig({ reviewer: CODEX_SEAT });

  async function limited(name: string, config: Config) {
    const ref = setupRun(name, { ledger: true });
    await rememberDetectedTools(
      ref.projectDir,
      cliDetectionsFor('ready', ['codex', 'claude-code']),
    );
    const run = await review({
      ref,
      config,
      throws: error('runner-call-failed', 'Planner reviewer call failed', {
        status: 'failed',
        error: { code: 'codex-turn-failed', message: CODEX_LIMIT },
      }),
    });
    return { ref, ...run, issue: run.result.state.pendingRecovery };
  }

  it('halts on the review seat with the reset, not as a review that failed', async () => {
    const { result, events, reviewCalls, issue } = await limited('review-limit', followsPlan);

    expect(reviewCalls).toBe(1);
    expect(issue?.reason).toBe('runner-usage-limit');
    expect(issue?.seat).toBe('review');
    expect(issue?.taskId).toBeUndefined();
    expect(issue?.facts?.tool).toBe('OpenAI Codex CLI');
    expect(new Date(issue?.resetAt ?? '')).toEqual(new Date(2026, 9, 3, 13, 2));
    expect(issue?.details).toEqual([
      `OpenAI Codex CLI reported: ${CODEX_LIMIT}`,
      'no fallback set',
      'REVIEW uses PLAN. Switching here gives REVIEW its own seat.',
    ]);
    expect(issue?.message).toContain('hit its usage limit');
    expect(issue?.message).not.toContain('codex login');
    // The error row carries the halt's reset for the row to spell; its words name no clock, and
    // codex's own words drop theirs.
    const row = events.find((event) => event.type === 'error');
    expect(row?.type === 'error' && row.resetAt).toBe(issue?.resetAt);
    const rowText = row?.type === 'error' ? row.message : '';
    expect(rowText).not.toMatch(/13:02|1:02 PM|try again/);
    expect(issue?.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'retry-later',
      'end-run',
    ]);
    expect(issue?.recommendedAction).toBe('switch-seat');
    // Nothing was judged, so the run waits on the review it never finished.
    expect(result.state.phase).toBe('final-review');
    expect(result.state.reviewStatus).toBeUndefined();
    expect(events.find((event) => event.type === 'workflow_complete')).toBeUndefined();
  });

  it('offers the REVIEW move for both inherited and explicit reviewers', async () => {
    const follows = await limited('review-limit-follows', followsPlan);
    const own = await limited('review-limit-own', ownSeat);

    expect(follows.issue?.switchSeat).toEqual({
      seat: 'review',
      candidates: [{ tool: 'claude-code' }],
    });
    expect(own.issue?.switchSeat).toEqual({
      seat: 'review',
      candidates: [{ tool: 'claude-code' }],
    });
  });

  it('moves the reviewer block for both inherited and explicit reviewers', async () => {
    const candidate = { tool: 'claude-code', model: 'opus' };
    const follows = await limited('review-swap-follows', followsPlan);
    const own = await limited('review-swap-own', ownSeat);

    const movedInheritedReview = await applyRecoveryAction({
      ...follows.ref,
      state: follows.result.state,
      action: 'switch-seat',
      candidate,
      bus: makeBusRecorder().bus,
      config: followsPlan,
    });
    const movedReview = await applyRecoveryAction({
      ...own.ref,
      state: own.result.state,
      action: 'switch-seat',
      candidate,
      bus: makeBusRecorder().bus,
      config: ownSeat,
    });

    expect(movedInheritedReview).toMatchObject({ ok: true, status: 'continued' });
    expect(movedReview).toMatchObject({ ok: true, status: 'continued' });
    if (!movedInheritedReview.ok || !movedReview.ok)
      throw new Error('expected both swaps to apply');
    expect(movedInheritedReview.switchedConfig?.planner).toEqual(followsPlan.planner);
    expect(movedInheritedReview.switchedConfig?.reviewer).toMatchObject({
      tool: 'claude-code',
      model: 'opus',
    });
    expect(movedReview.switchedConfig?.reviewer).toMatchObject({
      tool: 'claude-code',
      model: 'opus',
    });
    expect(movedReview.switchedConfig?.planner).toEqual(ownSeat.planner);
    expect(movedInheritedReview.state.pendingRecovery).toBeUndefined();
  });
});

describe('a REVIEW seat signed out', () => {
  // Captured from `codex exec --json` (codex-cli 0.146.0, 2026-08-06) against a dead login.
  const CODEX_SIGNED_OUT =
    'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';

  it('halts on the review seat with the login, not as a review that failed', async () => {
    const ref = setupRun('review-signed-out', { ledger: true });
    await rememberDetectedTools(
      ref.projectDir,
      cliDetectionsFor('ready', ['codex', 'claude-code']),
    );
    const { result, reviewCalls } = await review({
      ref,
      config: makeNoValidationConfig({ planner: CODEX_SEAT }),
      throws: error('runner-call-failed', 'Planner reviewer call failed', {
        status: 'failed',
        error: { code: 'codex-turn-failed', message: CODEX_SIGNED_OUT },
      }),
    });

    const issue = result.state.pendingRecovery;
    expect(reviewCalls).toBe(1);
    expect(issue).toMatchObject({
      reason: 'runner-unauthenticated',
      seat: 'review',
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'review', candidates: [{ tool: 'claude-code' }] },
    });
    expect(issue?.taskId).toBeUndefined();
    expect(issue?.message).toContain('`codex logout` then `codex login`');
    expect(issue?.message).not.toContain('usage limit');
    expect(issue?.details).toContain(`OpenAI Codex CLI reported: ${CODEX_SIGNED_OUT}`);
    expect(result.state.phase).toBe('final-review');
    expect(result.state.reviewStatus).toBeUndefined();
  });
});
