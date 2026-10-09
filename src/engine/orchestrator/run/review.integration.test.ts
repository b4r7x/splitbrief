import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
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
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { saveState } from '../../../core/state/persistence.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import { recoveryActionLabel } from '../../../core/recovery/action-label.js';
import type { FinalReviewResult } from '../final-review.js';
import type { Planner } from '../../planners/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import {
  followReviewAnswer,
  haltVerdictlessReview,
  reviewPassed,
  runScheduledReview,
} from './review.js';

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

describe('review answer follower', () => {
  const fixWork = { fixTasks: [], rejected: [], verify: [], ask: null };
  const input = {
    id: 'P1',
    kind: 'defect' as const,
    source: 'check' as const,
    file: 'src/a.ts',
    text: 'Typecheck failed',
  };

  it('does not pass a passing verdict while a check input remains pending', () => {
    expect(
      reviewPassed(
        {
          kind: 'pass',
          blocking: [],
          minor: [],
          unverifiedCriteria: [],
          coverageErrors: [],
          criteria: [],
        },
        fixWork,
        [input],
        [],
      ),
    ).toBe(false);
  });

  it('queues the answer to a reviewer question for another review without a planner call', async () => {
    const ref = setupProject();
    const state = {
      ...pendingReview(),
      phase: 'final-review' as const,
      pendingTriage: { inputs: [input] },
    };
    saveState(ref, state);
    const callbacks = makeCallbacks({
      onPlannerReply: vi.fn(async () => 'Keep the planned API'),
    }).callbacks;
    const planner = makePlanner({ typedCall: vi.fn() });
    const result = await followReviewAnswer({
      wctx: makeWctx({ ...ref, callbacks, planner }),
      state,
      callbacks,
      setTrackedState: vi.fn(),
      candidate: undefined,
      recheckFailures: [],
      fixWork: {
        ...fixWork,
        ask: {
          question: 'Change the API?',
          whyOnlyUserCanAnswer: 'The plan defines the public API.',
        },
      },
    });
    expect(result).toMatchObject({ stopped: false, reviewAgain: true });
    expect(result.state.phase).toBe('final-review');
    expect(result.state.pendingTriage?.inputs).toEqual([
      input,
      { id: 'A2', kind: 'answer', source: 'user', text: 'Keep the planned API', file: null },
    ]);
    expect(result.state.pendingTriage?.question).toBeUndefined();
    expect(result.state.fixCycles?.used).toBe(2);
    expect(planner.typedCall).not.toHaveBeenCalled();
  });

  it('halts when no callback can answer the reviewer question', async () => {
    const ref = setupProject();
    const state = { ...pendingReview(), phase: 'final-review' as const };
    saveState(ref, state);
    const callbacks = makeCallbacks().callbacks;
    const result = await followReviewAnswer({
      wctx: makeWctx({ ...ref, callbacks }),
      state,
      callbacks,
      setTrackedState: vi.fn(),
      candidate: undefined,
      recheckFailures: [],
      fixWork: {
        ...fixWork,
        ask: {
          question: 'Change the API?',
          whyOnlyUserCanAnswer: 'The plan defines the public API.',
        },
      },
    });
    expect(result).toMatchObject({ stopped: true, reviewAgain: false });
    expect(result.state.pendingRecovery?.details?.join('\n')).toContain(
      'The review asked a question this run has no way to answer.',
    );
    expect(result.state.pendingTriage?.question?.question).toBe('Change the API?');
  });

  it('halts at the cap with a red input without REVIEW_DONE or Accept as is', async () => {
    const ref = setupProject();
    const state = {
      ...pendingReview(),
      phase: 'final-review' as const,
      pendingTriage: { inputs: [input] },
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const callbacks = makeCallbacks().callbacks;
    const result = await followReviewAnswer({
      wctx: makeWctx({ ...ref, bus, callbacks }),
      state,
      callbacks,
      setTrackedState: vi.fn(),
      candidate: undefined,
      recheckFailures: [],
      fixWork,
    });
    expect(result.stopped).toBe(true);
    expect(result.state.phase).toBe('final-review');
    expect(result.state.completedAt).toBeUndefined();
    expect(result.state.reviewStatus).toBeUndefined();
    expect(result.state.pendingRecovery?.facts).toMatchObject({ fixCycles: 2 });
    expect(result.state.pendingRecovery?.availableActions).not.toContain('accept-as-is');
    expect(result.state.pendingRecovery?.details?.join('\n')).toContain('P1');
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
    const corrected = await applyRecoveryAction({
      ...ref,
      state: result.state,
      action: 'revise',
      comment: 'Fix the typecheck failure',
      bus,
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) throw new Error(corrected.message);
    expect(corrected.state.phase).toBe('final-review');
    expect(corrected.state.fixCycles?.allowance).toBe(3);
    expect(corrected.state.pendingTriage?.inputs).toEqual([
      input,
      expect.objectContaining({ text: 'Fix the typecheck failure' }),
    ]);
  });

  it.each(['rejected', 'ask'] as const)(
    'keeps a pending red input blocking when the reviewer returns %s',
    async (answer) => {
      const ref = setupProject();
      const state: WorkflowState = {
        ...pendingReview(),
        phase: 'final-review',
        fixCycles: { used: 0, allowance: 2, notes: [] },
        pendingTriage: { inputs: [input] },
      };
      saveState(ref, state);
      const { bus, events } = makeBusRecorder();
      const callbacks = makeCallbacks().callbacks;
      const result = await followReviewAnswer({
        wctx: makeWctx({ ...ref, bus, callbacks }),
        state,
        callbacks,
        setTrackedState: vi.fn(),
        candidate: undefined,
        recheckFailures: ['Typecheck failed'],
        fixWork: {
          ...fixWork,
          rejected: answer === 'rejected' ? [{ findingId: 'P1', reason: 'No change needed' }] : [],
          ask:
            answer === 'ask'
              ? { question: 'Change the API?', whyOnlyUserCanAnswer: 'The API is public.' }
              : null,
        },
      });
      expect(result.stopped).toBe(true);
      expect(result.state.phase).toBe('final-review');
      expect(result.state.reviewStatus).toBeUndefined();
      expect(result.state.completedAt).toBeUndefined();
      expect(result.state.pendingRecovery?.availableActions).not.toContain('accept-as-is');
      expect(result.state.pendingRecovery?.details?.join('\n')).toContain('P1: Typecheck failed');
      expect(result.state.pendingRecovery?.facts?.blocking).toBe(2);
      expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
    },
  );
});

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
  it('waits for the saved review question before another review call', async () => {
    const ref = setupProject();
    const state: WorkflowState = {
      ...scheduledReviewState(),
      review: pendingReview().review,
      pendingTriage: {
        inputs: [],
        question: { question: 'Change the API?', whyOnlyUserCanAnswer: 'The API is public.' },
      },
    };
    saveState(ref, state);
    let asked = false;
    const callbacks = makeCallbacks({
      onPlannerReply: vi.fn(async (reply) => {
        expect(reply.text).toBe('Change the API?');
        asked = true;
        return 'Keep the API';
      }),
    }).callbacks;
    const checks = vi.fn(() => ({ commands: [], declined: [], reason: 'No command is needed.' }));
    const planner = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks(state.tasks),
        (prompt) => {
          expect(asked).toBe(true);
          expect(prompt).toContain('Keep the API');
          return {
            ...passingReviewVerdict(prompt),
            rejected: [{ findingId: 'A1', reason: 'The answer keeps the approved API' }],
          };
        },
        undefined,
        checks,
      ),
    });
    const result = await runScheduledReview({
      wctx: makeWctx({
        ...ref,
        callbacks,
        planner,
        config: makeNoValidationConfig({ validation: { endChecks: true } }),
      }),
      state,
      callbacks,
      setTrackedState: vi.fn(),
    });
    expect(result.status).toBe('continue');
    expect(callbacks.onPlannerReply).toHaveBeenCalledOnce();
    expect(checks).not.toHaveBeenCalled();
    expect(result.state.pendingTriage).toBeUndefined();
  });

  it('re-reviews an answer without another reviewer-checks plan call', async () => {
    const ref = setupProject();
    const state = scheduledReviewState();
    saveState(ref, state);
    const callbacks = makeCallbacks({
      onPlannerReply: vi.fn(async () => 'Keep the API'),
    }).callbacks;
    const checks = vi.fn(() => ({ commands: [], declined: [], reason: 'No command is needed.' }));
    const reviewPrompts: string[] = [];
    const planner = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks(state.tasks),
        (prompt, call) => {
          reviewPrompts.push(prompt);
          return call === 1
            ? {
                ...passingReviewVerdict(prompt),
                ask: { question: 'Change the API?', whyOnlyUserCanAnswer: 'The API is public.' },
              }
            : {
                ...passingReviewVerdict(prompt),
                rejected: [{ findingId: 'A1', reason: 'The answer keeps the approved API' }],
              };
        },
        undefined,
        checks,
      ),
    });
    const result = await runScheduledReview({
      wctx: makeWctx({
        ...ref,
        callbacks,
        planner,
        config: makeNoValidationConfig({ validation: { endChecks: true } }),
      }),
      state,
      callbacks,
      setTrackedState: vi.fn(),
    });
    expect(result.status).toBe('continue');
    expect(reviewPrompts).toHaveLength(2);
    expect(reviewPrompts[1]).toContain('Keep the API');
    expect(checks).toHaveBeenCalledOnce();
    expect(callbacks.onPlannerReply).toHaveBeenCalledOnce();
    expect(result.state.pendingTriage).toBeUndefined();
    expect(result.state.pendingScheduledReview).toBeUndefined();
  });

  it('halts a scheduled review at its cap and resumes triage with pending tasks intact', async () => {
    const ref = setupProject();
    const state = pendingReview();
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const triagePrompts: string[] = [];
    const callbacks = makeCallbacks().callbacks;
    const planner = makePlanner({
      typedCall: typedCallPlanAndReview(
        () => planFromTasks(state.tasks),
        (prompt, call) => {
          if (call === 1)
            return failedReviewVerdict(prompt, 'Preserve the error', { taskId: 'T001' });
          triagePrompts.push(prompt);
          return {
            ...passingReviewVerdict(prompt),
            rejected: [{ findingId: 'U2', reason: 'The correction guides continuation' }],
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
    expect(continued.state.fixCycles?.used).toBe(2);
    expect(continued.state.pendingScheduledReview).toBeUndefined();
    expect(triagePrompts).toHaveLength(1);
    expect(triagePrompts[0]).toContain('Keep the reviewed correction');
    expect(events.filter((event) => event.type === 'workflow_complete')).toEqual([]);
  });

  it('keeps a twice-invalid review answer on the reviewer seat', async () => {
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
      typedCall: typedCallPlanAndReview(
        () => planFromTasks(state.tasks),
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
      seat: 'review',
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
    // Skipping one task's review never makes the whole run ready to apply or closes it.
    expect(deriveRunStatus({ state: skipped.state, liveness: 'not-alive' }).kind).toBe('open');
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

  it.each(['worktree', 'checkout', 'no-workspace'] as const)(
    'offers accept as is when the final review hits the input cap in %s',
    async (kind) => {
      const ref = setupProject();
      const workspace = {
        kind: kind === 'checkout' ? ('checkout' as const) : ('worktree' as const),
        path: ref.projectDir,
        base: { snapshotId: 'base', head: null },
      };
      const state: WorkflowState = {
        ...makeImplState([makeTask({ id: 'T001', status: 'done' })]),
        phase: 'final-review',
        ...(kind !== 'no-workspace' && { workspace }),
      };
      saveState(ref, state);
      const { bus } = makeBusRecorder();
      const wctx = makeWctx({ ...ref, config: makeNoValidationConfig(), bus });
      const review: FinalReviewResult = {
        state,
        verdict: null,
        fixWork: null,
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
      if (halted === undefined) throw new Error('Review did not halt');
      const accepted = await applyRecoveryAction({
        ...ref,
        state: halted,
        action: 'accept-as-is',
        bus,
      });
      expect(accepted.ok).toBe(true);
      expect(accepted.state.reviewStatus).toBe('failed');
      expect(deriveRunStatus({ state: accepted.state, liveness: 'not-alive' }).kind).toBe(
        kind === 'worktree' ? 'ready-to-apply' : 'closed',
      );
    },
  );

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
      typedCall: typedCallPlanAndReview(
        () => planFromTasks(state.tasks),
        (prompt) => {
          reviewCalls += 1;
          return passingReviewVerdict(prompt);
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
