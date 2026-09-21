import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeImplementer,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import { REVIEW_FILE, SPEC_FILE, TASKS_FILE, sessionDir } from '../../core/paths.js';
import { createEvidenceLedger } from '../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { createInitialState } from '../../core/state/machine.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import { allowedActionsForReason } from '../../core/schemas/recovery/policy.js';
import { RecoveryIssueSchema, type RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { NO_ARTIFACTS, deriveRunStatus } from '../../core/sessions/run-status.js';
import type { Config } from '../../core/schemas/config.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EngineEvent } from '../events/types.js';
import { apiContextError, type ApiContextDiagnostic } from '../providers/api-context-diagnostic.js';
import { runPlanningSteps } from './planning/steps.js';
import { applyRecoveryAction } from './recovery/actions.js';
import { MAX_SUMMARY_LENGTH } from './recovery/builders/issue.js';
import { buildPlannerCallFailedRecoveryIssue } from './recovery/builders/planner.js';
import { buildReviewFailedRecoveryIssue } from './recovery/builders/task.js';
import { runTasksAndReview } from './run/task-execution.js';

const universe = vi.hoisted(() => ({ fullDiff: '', changedFiles: [] as string[] }));
const drift = vi.hoisted(() => ({ fails: false }));
const planContext = vi.hoisted(() => ({ throws: null as unknown }));
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

// The plan seat's required context, refusing where the run assembles it.
vi.mock('../planners/context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../planners/context.js')>();
  return {
    ...actual,
    buildProjectContextMarkdown: async (projectDir: string) => {
      if (planContext.throws !== null) throw planContext.throws;
      return actual.buildProjectContextMarkdown(projectDir);
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
  planContext.throws = null;
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
  async function plan(ref: { projectDir: string; sessionId: string }, thrown: unknown) {
    planContext.throws = thrown;
    const planner = makePlanner();
    const state: WorkflowState = { ...createInitialState('Add a login route'), mode: 'quick' };
    saveState(ref, state);
    const wctx = makeWctx({ ...ref, planner, reviewer: planner });

    const result = await runPlanningSteps({ wctx, planner, state, feature: 'Add a login route' });

    if (result.disposition !== 'terminal') throw new Error('expected a terminal planning result');
    expect(result.outcome).toBe('halted');
    return { state: result.state, issue: result.state.pendingRecovery, planner };
  }

  it('halts on the plan seat before the first call, with the cause and the sections kept', async () => {
    const ref = setupSession('plan-context');
    const missingSections = ['spec.md', 'src/login.ts'];

    const { state, issue, planner } = await plan(
      ref,
      apiContextError(diagnostic({ missingSections, cause: 'missing-required', ...ESTIMATES })),
    );

    expect(planner.runPhase).not.toHaveBeenCalled();
    expect(state.phase).toBe('idle');
    expect(issue?.reason).toBe('planner-call-failed');
    expect(issue?.seat).toBe('plan');
    expect(issue?.taskId).toBeUndefined();
    expect(issue?.facts?.apiContextCode).toBe('insufficient-context');
    expect(issue?.facts?.apiContextSeat).toBe('plan');
    expect(issue?.facts?.apiContextCause).toBe('missing-required');
    expect(JSON.parse(factString(issue, 'apiContextMissingSectionsJson'))).toEqual(missingSections);
    // There is no brief here to route, skip or repair: the seat runs again or it does not.
    expect(issue?.availableActions).not.toContain('route-bigger-worker');
    expect(issue?.availableActions).not.toContain('skip-current-task');
    expect(loadState(ref)?.pendingRecovery?.reason).toBe('planner-call-failed');
  });

  it('reads the diagnosis off the error data, not off wording that reads like a quota', async () => {
    const ref = setupSession('plan-quota-lookalike');

    // A project that names a fixture after the error it replays would otherwise
    // be told to wait for a limit to reset and to keep its planner seat.
    const { issue } = await plan(
      ref,
      apiContextError(diagnostic({ missingSections: ['fixtures/insufficient_quota.json'] })),
    );

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
        mode: 'standard',
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

const PASS_REVIEW = '### Verdict\npass\n\n### Summary\nGood.\n';
const CRITICAL_REVIEW =
  '### Verdict\nfail\n\n### Findings\n- **Critical**: src/login.ts leaks the token\n';

async function review(opts: {
  ref: { projectDir: string; sessionId: string };
  config: Config;
  reviews?: string[] | undefined;
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
    review: async () => {
      reviewCalls += 1;
      if (opts.throws !== undefined) throw opts.throws;
      const texts = opts.reviews ?? [PASS_REVIEW];
      return {
        text: texts[Math.min(reviewCalls - 1, texts.length - 1)] ?? PASS_REVIEW,
        usage: null,
      };
    },
  });
  const implementer = makeImplementer();
  const tasks: Task[] = [makeTask({ id: 'T001', file: 'src/login.ts', status: 'done' })];
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
    expect(result.cancelled).toBe(false);
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
    expect(
      deriveRunStatus({ state: result.state, liveness: 'not-alive', artifacts: NO_ARTIFACTS }).kind,
    ).toBe('open');
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

  it('treats a reply that names no verdict as a call that did not land', async () => {
    const ref = setupRun('review-unparseable', { ledger: true });

    const { result, reviewCalls } = await review({
      ref,
      config: makeNoValidationConfig(),
      reviews: ['### Summary\nIt is fine, I suppose.\n'],
    });

    // The reviewer gets its one re-ask before the run gives up on the verdict.
    expect(reviewCalls).toBe(2);
    expect(result.state.pendingRecovery?.seat).toBe('review');
    expect(result.state.pendingRecovery?.facts?.reviewFailureKind).toBe('call-failed');
    expect(result.state.pendingRecovery?.facts?.blocking).toBeUndefined();
    expect(result.state.phase).toBe('final-review');
  });
});

describe('a REVIEW that reached a verdict', () => {
  it('keeps a parsed fail on the build seat, with its count and its two exits', async () => {
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
    expect(issue?.availableActions).toEqual(['pause-run', 'end-run']);
    expect(result.state.phase).toBe('complete');
    expect(result.state.reviewStatus).toBe('failed');
    expect(events.find((event) => event.type === 'workflow_complete')).toMatchObject({
      review: 'failed',
      blocking: 1,
    });
  });

  it('still opens the bounded BUILD repair on a Critical finding', async () => {
    const ref = setupRun('review-repair', { ledger: true });

    const { result, events } = await review({
      ref,
      config: makeNoValidationConfig(),
      reviews: [CRITICAL_REVIEW, PASS_REVIEW],
    });

    expect(events.find((event) => event.type === 'review_fix_started')).toMatchObject({ cycle: 1 });
    expect(taskLoop.calls).toBe(2);
    expect(result.completed).toBe(true);
    expect(result.state.reviewStatus).toBe('passed');
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
        failure: 'call-failed',
        phase: 'planning',
        message: 'Planning failed.',
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
          failure: 'call-failed',
          phase: 'planning',
          message: 'Planning failed.',
          facts: { apiContextCode: 'insufficient-context', apiContextSeat: 'plan' },
          createdAt: CREATED_AT,
        });
  }

  it('leaves the halt pending across a pause, then clears it without resetting a brief', () => {
    const { ref, state } = halted('retry-review-seat', contextIssue('review'));
    const { bus, events } = makeBusRecorder();

    const paused = applyRecoveryAction({ ...ref, state, action: 'pause-run', bus, config });

    expect(paused).toMatchObject({ ok: true, status: 'paused' });
    // The pause parks it; nothing on the way back in clears it.
    expect(loadState(ref)?.pendingRecovery?.status).toBe('paused');

    const retried = applyRecoveryAction({
      ...ref,
      state: paused.state,
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

  it('clears a plan-seat halt the same way', () => {
    const { ref, state } = halted('retry-plan-seat', contextIssue('plan'));
    const { bus, events } = makeBusRecorder();

    const retried = applyRecoveryAction({
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

  it('clears a review call that did not land the same way', () => {
    const issue = buildReviewFailedRecoveryIssue({
      failure: { kind: 'call-failed', code: 'review-unavailable', message: 'socket hang up' },
      createdAt: CREATED_AT,
    });
    const { ref, state } = halted('retry-review-call', issue);
    const { bus, events } = makeBusRecorder();

    const retried = applyRecoveryAction({
      ...ref,
      state,
      action: 'retry-same-worker',
      bus,
      config,
    });

    expect(retried).toMatchObject({ ok: true, status: 'continued' });
    expect(events.some((event) => event.type === 'task_reset')).toBe(false);
  });

  it('refuses the retry a substantive review failure never offered', () => {
    const issue = buildReviewFailedRecoveryIssue({ blocking: 2, createdAt: CREATED_AT });
    const { ref, state } = halted('retry-substantive', issue);
    const { bus } = makeBusRecorder();

    const blocked = applyRecoveryAction({
      ...ref,
      state,
      action: 'retry-same-worker',
      bus,
      config,
    });

    expect(blocked).toMatchObject({ ok: false, code: 'action-not-available' });
    expect(blocked.state.pendingRecovery?.reason).toBe('review-failed');
    // The policy admits the action; only a non-verdict failure is offered it.
    expect(allowedActionsForReason('review-failed')).toContain('retry-same-worker');
  });

  it('still replays the brief when the halt names one', () => {
    const task = makeTask({ id: 'T001', status: 'in_progress' });
    const seatless = contextIssue('review');
    const issue: RecoveryIssue = { ...seatless, taskId: task.id, taskTitle: task.title };
    const { ref, state } = halted('retry-named-brief', issue, {
      tasks: [task],
      phase: 'implementing',
      currentTaskIndex: 0,
    });
    const { bus, events } = makeBusRecorder();

    const retried = applyRecoveryAction({
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
    const cleared = applyRecoveryAction({
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
