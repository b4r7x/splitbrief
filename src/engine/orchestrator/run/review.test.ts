import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import type { Plan } from '../../../core/schemas/plan.js';
import { taskId } from '../../../core/schemas/task.js';
import {
  makeBusRecorder,
  makeCallbacks,
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
import { loadState, saveState } from '../../../core/state/persistence.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { awaitsApply } from '../../../core/sessions/run-status.js';
import { recoveryActionLabel } from '../../../core/recovery/action-label.js';
import type { FinalReviewResult } from '../final-review.js';
import type { Planner } from '../../planners/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { haltVerdictlessReview, runScheduledReview } from './review.js';

const CODEX_INPUT_TOO_LARGE =
  'Error: turn/start: turn/start failed: Input exceeds the maximum length of 1048576 characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":1048576,"actual_chars":1106026}';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function setupProject(): { projectDir: string; sessionId: string } {
  const ref = setupGitSessionProject({ prefix: 'run-review-test', sessionId: 'sess-run-review' });
  dirs.push(ref.projectDir);
  return ref;
}

const RUN_BASELINE = { head: null, runStartChangedFiles: [], fingerprints: {} };

function pendingReview(): WorkflowState {
  return makeImplState([makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002' })], {
    changedFilesBaseline: { ...RUN_BASELINE },
    review: {
      scope: 'task',
      afterTaskId: taskId('T001'),
      cycle: 2,
      at: '2026-10-04T00:00:00Z',
      outcome: 'fail',
      verification: [],
      verdict: {
        tasks: [{ id: makeTask().id, plan: 'met', note: '' }],
        criteria: [],
        findings: [
          {
            id: 'F1',
            kind: 'defect',
            severity: 'blocking',
            taskId: null,
            file: null,
            line: null,
            text: 'Preserve the error',
            acceptance: null,
            checkIds: null,
            criterionId: null,
          },
        ],
      },
    },
    fixCycles: { used: 2, allowance: 2, notes: [] },
  });
}

function capState(): WorkflowState {
  return makeImplState([makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002' })], {
    changedFilesBaseline: { ...RUN_BASELINE },
    review: {
      scope: 'task',
      cycle: 0,
      at: '2026-10-04T00:00:00Z',
      outcome: 'pass',
      verification: [],
      verdict: { tasks: [], criteria: [], findings: [] },
    },
  });
}

/** A review seat whose one call is refused as larger than the tool accepts. */
function inputCapReviewer(): Planner {
  return makePlanner({
    typedCall: (ctx) => ({
      seat: ctx.seat,
      typedOutput: 'strict-native',
      canResume: false,
      invoke: async () =>
        makeRunnerCallResult({
          status: 'failed',
          text: '',
          error: { code: 'input-too-large', message: CODEX_INPUT_TOO_LARGE },
        }),
    }),
  });
}

function scheduledReviewState(): WorkflowState {
  return makeImplState([makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002' })], {
    changedFilesBaseline: { ...RUN_BASELINE },
    pendingScheduledReview: { afterTaskId: taskId('T001') },
  });
}

function planWithRefusedCheck(): Plan {
  return {
    summary: 'Plan summary',
    decisions: [],
    criteria: [],
    checks: [{ id: 'K1', kind: 'cmd', value: 'npm run deploy', required: true }],
    validation: null,
  };
}

function firstFailsThenPassesReviewer(): Planner {
  let calls = 0;
  return makePlanner({
    typedCall: (ctx) => ({
      seat: ctx.seat,
      typedOutput: 'strict-native',
      canResume: false,
      invoke: async ({ prompt }) =>
        ++calls === 1
          ? makeRunnerCallResult({
              status: 'failed',
              text: '',
              error: { code: 'review-unavailable', message: 'The review seat is offline.' },
            })
          : makeRunnerCallResult({
              status: 'completed',
              text: JSON.stringify(passingReviewVerdict(prompt)),
            }),
    }),
  });
}

describe('runScheduledReview saved recovery', () => {
  it('halts a scheduled review at its cap and resumes triage with pending tasks intact', async () => {
    const ref = setupProject();
    const state = pendingReview();
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const triagePrompts: string[] = [];
    const callbacks = makeCallbacks().callbacks;
    const planner = makePlanner({
      typedCall: typedCallPlanReviewAndTriage(
        () => planFromTasks(state.tasks),
        (prompt) => failedReviewVerdict(prompt, 'Preserve the error', { taskId: 'T001' }),
        (prompt) => {
          triagePrompts.push(prompt);
          return {
            ...rejectingTriageResult(prompt),
            rejected: [
              { findingId: 'F1', reason: 'The review concern is answered' },
              { findingId: 'U1', reason: 'The correction guides continuation' },
            ],
          };
        },
      ),
    });
    const wctx = makeWctx({ ...ref, config: makeNoValidationConfig(), bus, callbacks, planner });
    const args = {
      wctx,
      state,
      callbacks,
      setTrackedState: vi.fn(),
      afterTaskId: taskId('T001'),
    };
    const halted = await runScheduledReview(args);
    expect(halted.status).toBe('stopped');
    expect(halted.state.phase).toBe('implementing');
    expect(halted.state.reviewStatus).toBeUndefined();
    expect(halted.state.tasks).toEqual(state.tasks);
    expect(halted.state.review?.scope).toBe('task');
    expect(halted.state.pendingScheduledReview).toEqual({ afterTaskId: 'T001' });
    expect(halted.state.pendingTriage).toEqual({ inputs: [], reviewAfterTaskId: 'T001' });
    expect(halted.state.pendingRecovery?.facts?.blocking).toBe(1);
    expect(halted.state.pendingRecovery?.availableActions).not.toContain('accept-as-is');
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([]);
    expect(triagePrompts).toEqual([]);
    const corrected = await applyRecoveryAction({
      ...ref,
      state: halted.state,
      action: 'revise',
      comment: 'Keep the reviewed correction',
      bus,
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error(corrected.message);
    const continued = await runScheduledReview({ ...args, state: corrected.state });
    expect(continued.status).toBe('continue');
    expect(continued.state.phase).toBe('implementing');
    expect(continued.state.tasks).toEqual(state.tasks);
    expect(continued.state.fixCycles?.used).toBe(3);
    expect(continued.state.pendingScheduledReview).toBeUndefined();
    expect(triagePrompts).toHaveLength(1);
    expect(triagePrompts[0]).toContain('Keep the reviewed correction');
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([]);
  });

  it('keeps a twice-invalid triage error on the plan seat', async () => {
    const ref = setupProject();
    const state = {
      ...pendingReview(),
      fixCycles: { used: 0, allowance: 2, notes: [] },
      pendingScheduledReview: { afterTaskId: taskId('T001') },
      pendingTriage: { inputs: [], reviewAfterTaskId: taskId('T001') },
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const callbacks = makeCallbacks().callbacks;
    const planner = makePlanner({
      typedCall: typedCallPlanReviewAndTriage(
        () => planFromTasks(state.tasks),
        () => {
          throw new Error('The saved review must be reused');
        },
        () => '{}',
      ),
    });
    const result = await runScheduledReview({
      wctx: makeWctx({ ...ref, config: makeNoValidationConfig(), bus, callbacks, planner }),
      state,
      callbacks,
      setTrackedState: vi.fn(),
    });
    expect(result.status).toBe('stopped');
    expect(result.state.phase).toBe('implementing');
    expect(result.state.pendingTriage).toBeDefined();
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'seat-protocol-error',
      seat: 'plan',
    });
    expect(result.state.pendingRecovery?.availableActions).toContain('retry-same-worker');
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([]);
  });

  it('offers skip with a note when a task-cadence review hits the input cap', async () => {
    const ref = setupProject();
    const state = capState();
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const callbacks = makeCallbacks().callbacks;
    const reviewer = inputCapReviewer();
    const wctx = makeWctx({
      ...ref,
      config: makeNoValidationConfig(),
      bus,
      callbacks,
      planner: reviewer,
      reviewer,
    });
    const halted = await runScheduledReview({
      wctx,
      state,
      callbacks,
      setTrackedState: vi.fn(),
      afterTaskId: taskId('T001'),
    });

    expect(halted.status).toBe('stopped');
    expect(halted.state.phase).toBe('implementing');
    expect(halted.state.pendingTriage).toBeDefined();
    expect(halted.state.pendingScheduledReview).toEqual({ afterTaskId: 'T001' });
    const issue = halted.state.pendingRecovery;
    expect(issue?.reason).toBe('review-input-too-large');
    expect(issue?.availableActions).toEqual(expect.arrayContaining(['accept-as-is', 'end-run']));
    expect(recoveryActionLabel('accept-as-is', { reason: 'review-input-too-large' })).toBe(
      'Skip review with a note',
    );

    const skipped = await applyRecoveryAction({
      ...ref,
      state: halted.state,
      action: 'accept-as-is',
      comment: 'Reviewed the diff by hand.',
      bus,
    });
    expect(skipped).toMatchObject({ ok: true, status: 'continued' });
    if (!skipped.ok) throw new Error(skipped.message);
    expect(skipped.state.phase).toBe('implementing');
    expect(skipped.state.pendingTriage).toBeUndefined();
    expect(skipped.state.pendingScheduledReview).toBeUndefined();
    expect(skipped.state.pendingRecovery).toBeUndefined();
    expect(skipped.state.review?.scope).toBe('task');
    expect(skipped.state.acceptedAsIs?.findings).toContain('Reviewed the diff by hand.');
    // Skipping one task's review never makes the whole run ready to apply.
    expect(awaitsApply(skipped.state)).toBe(false);
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([]);
  });

  it('keeps the scheduled review pending after a verdictless halt and re-runs it on continue', async () => {
    const ref = setupProject();
    const state = scheduledReviewState();
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const callbacks = makeCallbacks().callbacks;
    const reviewer = firstFailsThenPassesReviewer();
    const wctx = makeWctx({
      ...ref,
      config: makeNoValidationConfig(),
      bus,
      callbacks,
      planner: reviewer,
      reviewer,
    });
    const args = { wctx, state, callbacks, setTrackedState: vi.fn() };
    const halted = await runScheduledReview(args);

    expect(halted.status).toBe('stopped');
    expect(halted.state.phase).toBe('implementing');
    expect(halted.state.pendingScheduledReview).toEqual({ afterTaskId: 'T001' });
    expect(halted.state.pendingRecovery?.reason).toBe('review-failed');
    expect(halted.state.pendingRecovery?.availableActions).toContain('retry-same-worker');

    const corrected = await applyRecoveryAction({
      ...ref,
      state: halted.state,
      action: 'retry-same-worker',
      bus,
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error(corrected.message);

    const resumed = await runScheduledReview({ ...args, state: corrected.state });
    expect(resumed.status).toBe('continue');
    expect(resumed.state.phase).toBe('implementing');
    expect(resumed.state.review?.scope).toBe('task');
    expect(resumed.state.review?.afterTaskId).toBe('T001');
    expect(resumed.state.pendingScheduledReview).toBeUndefined();
    expect(resumed.state.pendingTriage).toBeUndefined();
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([]);
  });

  it('keeps the scheduled review pending when a pre-review halt stops it and re-runs on continue', async () => {
    const ref = setupProject();
    const state = {
      ...scheduledReviewState(),
      plan: planWithRefusedCheck(),
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const callbacks = makeCallbacks().callbacks;
    const planner = makePlanner({
      typedCall: typedCallPlanReviewAndTriage(
        () => planFromTasks(state.tasks),
        (prompt) => passingReviewVerdict(prompt),
        (prompt) => rejectingTriageResult(prompt),
      ),
    });
    const wctx = makeWctx({ ...ref, config: makeNoValidationConfig(), bus, callbacks, planner });
    const args = { wctx, state, callbacks, setTrackedState: vi.fn() };
    const halted = await runScheduledReview(args);

    expect(halted.status).toBe('stopped');
    expect(halted.state.pendingScheduledReview).toEqual({ afterTaskId: 'T001' });
    expect(halted.state.pendingRecovery?.reason).toBe('required-checks-unrunnable');

    const corrected = await applyRecoveryAction({
      ...ref,
      state: halted.state,
      action: 'retry-same-worker',
      bus,
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error(corrected.message);

    const fixed: WorkflowState = {
      ...corrected.state,
      plan: {
        ...planWithRefusedCheck(),
        checks: [{ id: 'K1', kind: 'cmd', value: 'node --version', required: true }],
      },
    };
    const resumed = await runScheduledReview({ ...args, state: fixed });
    expect(resumed.status).toBe('continue');
    expect(resumed.state.review?.scope).toBe('task');
    expect(resumed.state.pendingScheduledReview).toBeUndefined();
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([]);
  });

  it('clears the scheduled review when its pre-review queues fix work, so a restart runs the fix first', async () => {
    const ref = setupProject();
    const state: WorkflowState = {
      ...scheduledReviewState(),
      plan: {
        ...planWithRefusedCheck(),
        checks: [{ id: 'K1', kind: 'cmd', value: 'node --no-such-flag', required: true }],
      },
    };
    saveState(ref, state);
    const { bus } = makeBusRecorder();
    const callbacks = makeCallbacks().callbacks;
    const review = vi.fn((prompt: string) => passingReviewVerdict(prompt));
    const planner = makePlanner({
      typedCall: typedCallPlanReviewAndTriage(
        () => planFromTasks(state.tasks),
        review,
        () => ({
          fixTasks: [
            {
              ...makeTaskSpec({ id: 'T003', suggestedFiles: ['src/fix.ts'], criteria: [] }),
              findingIds: ['P1'],
            },
          ],
          rejected: [],
          verify: [],
          ask: null,
        }),
      ),
    });
    const wctx = makeWctx({ ...ref, config: makeNoValidationConfig(), bus, callbacks, planner });
    const result = await runScheduledReview({
      wctx,
      state,
      callbacks,
      setTrackedState: vi.fn(),
    });

    expect(result.status).toBe('continue');
    expect(review).not.toHaveBeenCalled();
    expect(result.state.tasks.map((task) => task.id)).toContain('T003');
    expect(result.state.pendingScheduledReview).toBeUndefined();
    expect(loadState(ref)?.pendingScheduledReview).toBeUndefined();
  });

  it('keeps the accept-as-is offer when the final review hits the input cap', async () => {
    const ref = setupProject();
    const workspace = {
      kind: 'worktree' as const,
      path: ref.projectDir,
      base: { snapshotId: 'base', head: null },
    };
    const state: WorkflowState = {
      ...makeImplState([makeTask({ id: 'T001', status: 'done' })]),
      phase: 'final-review',
      workspace,
    };
    saveState(ref, state);
    const { bus } = makeBusRecorder();
    const wctx = makeWctx({ ...ref, config: makeNoValidationConfig(), bus });
    const review: FinalReviewResult = {
      state,
      verdict: null,
      reviewText: '',
      reviewStatus: 'failed',
      failure: {
        kind: 'input-too-large',
        chars: 1_106_026,
        maxChars: 1_048_576,
        largestFiles: [],
      },
    };

    const halted = await haltVerdictlessReview({ wctx, state, setTrackedState: vi.fn(), review });

    expect(halted?.pendingRecovery?.reason).toBe('review-input-too-large');
    expect(halted?.pendingRecovery?.availableActions).toEqual(
      expect.arrayContaining(['accept-as-is', 'end-run']),
    );
    expect(halted?.pendingTriage).toBeUndefined();
    expect(halted?.pendingScheduledReview).toBeUndefined();
  });

  it('offers only end-run when a checkout run final review hits the input cap', async () => {
    const ref = setupProject();
    const workspace = {
      kind: 'checkout' as const,
      path: ref.projectDir,
      base: { snapshotId: 'base', head: null },
    };
    const state: WorkflowState = {
      ...makeImplState([makeTask({ id: 'T001', status: 'done' })]),
      phase: 'final-review',
      workspace,
    };
    saveState(ref, state);
    const { bus } = makeBusRecorder();
    const wctx = makeWctx({ ...ref, config: makeNoValidationConfig(), bus });
    const review: FinalReviewResult = {
      state,
      verdict: null,
      reviewText: '',
      reviewStatus: 'failed',
      failure: {
        kind: 'input-too-large',
        chars: 1_106_026,
        maxChars: 1_048_576,
        largestFiles: [],
      },
    };

    const halted = await haltVerdictlessReview({ wctx, state, setTrackedState: vi.fn(), review });

    expect(halted?.pendingRecovery?.reason).toBe('review-input-too-large');
    expect(halted?.pendingRecovery?.availableActions).toEqual(['end-run']);
    expect(halted?.pendingTriage).toBeUndefined();
    expect(halted?.pendingScheduledReview).toBeUndefined();
  });

  it('resumes a verdictless scheduled review instead of triaging an older task verdict', async () => {
    const ref = setupProject();
    const state = makeImplState(
      [makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002', status: 'done' })],
      {
        changedFilesBaseline: { ...RUN_BASELINE },
        review: {
          scope: 'task',
          afterTaskId: taskId('T001'),
          cycle: 0,
          at: '2026-10-04T00:00:00Z',
          outcome: 'pass',
          verification: [],
          verdict: { tasks: [], criteria: [], findings: [] },
        },
        pendingScheduledReview: { afterTaskId: taskId('T002') },
        pendingTriage: { inputs: [], reviewAfterTaskId: taskId('T002') },
      },
    );
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const callbacks = makeCallbacks().callbacks;
    const triagePrompts: string[] = [];
    let reviewCalls = 0;
    const planner = makePlanner({
      typedCall: typedCallPlanReviewAndTriage(
        () => planFromTasks(state.tasks),
        (prompt) => {
          reviewCalls += 1;
          return passingReviewVerdict(prompt);
        },
        (prompt) => {
          triagePrompts.push(prompt);
          return rejectingTriageResult(prompt);
        },
      ),
    });
    const wctx = makeWctx({ ...ref, config: makeNoValidationConfig(), bus, callbacks, planner });
    const resumed = await runScheduledReview({ wctx, state, callbacks, setTrackedState: vi.fn() });

    expect(resumed.status).toBe('continue');
    expect(reviewCalls).toBe(1);
    expect(triagePrompts).toEqual([]);
    expect(resumed.state.review?.scope).toBe('task');
    expect(resumed.state.review?.afterTaskId).toBe('T002');
    expect(resumed.state.pendingTriage).toBeUndefined();
    expect(resumed.state.pendingScheduledReview).toBeUndefined();
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([]);
  });
});
