import { plainUserMessage } from '../../../core/types/user-input.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import {
  attachedMessage,
  expectCompactMessage,
  expectResumedMessage,
} from '#testing/helpers/user-message.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { cliDetectionsFor, rememberDetectedTools } from '#testing/helpers/factories/detection.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { taskId } from '../../../core/schemas/task.js';
import {
  disposeWctxIsolations,
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
import { loadConfig, writeConfig } from '../../../core/config/load/io.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import { recoveryActionLabel } from '../../../core/recovery/action-label.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { createSteeringPort } from '../../calls/steering.js';
import type { FinalReviewResult } from '../final-review.js';
import type { Planner, TypedCallContext } from '../../planners/types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { diagnosePlannerCallFailure } from '../recovery/planner-call-failure.js';
import { switchSeatAndPrepareResume } from '../recovery/switch-seat-resume.js';
import {
  followReviewAnswer,
  haltVerdictlessReview,
  reviewPassed,
  runScheduledReview,
} from './review.js';

const CODEX_INPUT_TOO_LARGE =
  'Error: turn/start: turn/start failed: Input exceeds the maximum length of 1048576 characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":1048576,"actual_chars":1106026}';

const dirs: string[] = [];
afterEach(async () => {
  await disposeWctxIsolations();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

function setupProject(): { projectDir: string; sessionId: string } {
  const ref = setupGitSessionProject({ prefix: 'run-review-test', sessionId: 'sess-run-review' });
  dirs.push(ref.projectDir);
  return ref;
}

const RUN_BASELINE = { head: null, runStartChangedFiles: [], fingerprints: {} };

describe('review answer follower', () => {
  it('delivers an attached file into reviewer triage and publishes compact text once', async () => {
    const projectDir = createTempDir('review-attached-file');
    dirs.push(projectDir);
    const ref = { projectDir, sessionId: 'review-attached-file' };
    ensureSessionDir(projectDir, ref.sessionId);
    const message = attachedMessage(projectDir);
    const qa = [{ question: 'Change the API?', answer: message.displayText }];
    const state = {
      ...pendingReview(),
      phase: 'final-review' as const,
      pendingTriage: { inputs: [input] },
    };
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    bus.subscribe(createJsonlSink(ref));
    const callbacks = makeCallbacks({ onPlannerReply: async () => ({ message, qa }) }).callbacks;
    const result = await followReviewAnswer({
      wctx: makeWctx({ ...ref, bus, callbacks }),
      state,
      callbacks,
      setTrackedState: () => {},
      candidate: undefined,
      recheckFailures: [],
      fixWork: {
        ...fixWork,
        ask: { question: 'Change the API?', whyOnlyUserCanAnswer: 'The plan defines the API' },
      },
    });
    expect(result.state.pendingTriage?.inputs.at(-1)?.text).toContain('PELICAN-42');
    expect(events.find((event) => event.type === 'user_message')).toMatchObject({ qa });
    await expectCompactMessage(ref, events, message);
    await expectResumedMessage(ref, message);
  });

  const fixWork = { fixTasks: [], rejected: [], verify: [], ask: null };
  const input = {
    id: 'P1',
    kind: 'defect' as const,
    source: 'check' as const,
    file: 'src/a.ts',
    text: 'Typecheck failed',
  };

  const passing = {
    kind: 'pass' as const,
    blocking: [],
    minor: [],
    outOfScope: [],
    unverifiedCriteria: [],
    coverageErrors: [],
    criteria: [],
    redInputs: [],
  };
  const notVerifiedInput = {
    id: 'V1.1',
    kind: 'defect' as const,
    source: 'check' as const,
    file: null,
    text: 'Reviewer check V1 (node tools/run.mjs) failed and failed at the run base too',
    notVerified: 'both runs exited with code 1 without diagnostics',
  };
  const newFailureInput = {
    id: 'V1.1',
    kind: 'defect' as const,
    source: 'check' as const,
    file: 'src/a.test.ts',
    text: 'Reviewer check V1 (npm test) failed with new failures.',
  };
  const applyConflictInput = {
    id: 'A1',
    kind: 'defect' as const,
    source: 'apply' as const,
    file: 'src/a.ts',
    text: 'Apply wrote conflict markers into src/a.ts',
  };
  const rejecting = (id: string) => ({
    ...fixWork,
    rejected: [{ findingId: id, reason: 'No change needed' }],
  });

  it('passes a passing verdict whose answer rejects a red the run base could not verify', () => {
    expect(reviewPassed(passing, rejecting(notVerifiedInput.id), [notVerifiedInput], [])).toBe(
      true,
    );
  });

  it.each([
    ['a red plan check', input],
    ['a reviewer check with new failures', newFailureInput],
    ['an Apply conflict', applyConflictInput],
  ])('does not pass a passing verdict whose answer rejects %s', (_name, red) => {
    expect(reviewPassed(passing, rejecting(red.id), [red], [])).toBe(false);
  });

  it('does not pass a passing verdict while a check input remains pending', () => {
    expect(reviewPassed(passing, fixWork, [input], [])).toBe(false);
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
      onPlannerReply: vi.fn(async () => plainUserMessage('Keep the planned API')),
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
      comment: plainUserMessage('Fix the typecheck failure'),
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

  it('keeps a pending red input blocking when the reviewer asks a question', async () => {
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
        ask: { question: 'Change the API?', whyOnlyUserCanAnswer: 'The API is public.' },
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
  });

  it('stops counting a red the run base could not verify once the reviewer rejects it', async () => {
    const ref = setupProject();
    const state: WorkflowState = {
      ...pendingReview(),
      phase: 'final-review',
      fixCycles: { used: 0, allowance: 2, notes: [] },
      pendingTriage: { inputs: [notVerifiedInput] },
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
      fixWork: rejecting(notVerifiedInput.id),
    });
    expect(result.stopped).toBe(true);
    expect(result.state.phase).toBe('complete');
    expect(result.state.reviewStatus).toBe('failed');
    expect(result.state.pendingRecovery?.availableActions).toContain('accept-as-is');
    expect(result.state.pendingRecovery?.details?.join('\n') ?? '').not.toContain('V1.1:');
    expect(result.state.pendingRecovery?.facts?.blocking).toBe(1);
    expect(events.filter((event) => event.type === 'workflow_complete')).toMatchObject([
      { review: 'failed', blocking: 1 },
    ]);
  });

  it.each([
    ['a red plan check', input],
    ['a reviewer check with new failures', newFailureInput],
    ['an Apply conflict', applyConflictInput],
  ])('keeps %s blocking when the reviewer rejects it', async (_name, red) => {
    const ref = setupProject();
    const state: WorkflowState = {
      ...pendingReview(),
      phase: 'final-review',
      fixCycles: { used: 0, allowance: 2, notes: [] },
      pendingTriage: { inputs: [red] },
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
      fixWork: rejecting(red.id),
    });
    expect(result.stopped).toBe(true);
    expect(result.state.phase).toBe('final-review');
    expect(result.state.reviewStatus).toBeUndefined();
    expect(result.state.pendingRecovery?.availableActions).not.toContain('accept-as-is');
    expect(result.state.pendingRecovery?.details?.join('\n')).toContain(`${red.id}: ${red.text}`);
    expect(result.state.pendingRecovery?.facts?.blocking).toBe(2);
    expect(events.some((event) => event.type === 'workflow_complete')).toBe(false);
  });
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
            taskId: 'T001',
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
  it('offers an inherited REVIEW swap and records its own seat without changing PLAN', async () => {
    const ref = setupProject();
    const config = makeNoValidationConfig({
      planner: { kind: 'cli', tool: 'codex', model: 'gpt-5-codex', effort: 'high' },
    });
    const fallback = { tool: 'claude-code', model: 'sonnet' };
    writeConfig(ref.projectDir, {
      ...config,
      planner: { ...config.planner, fallback },
    });
    const plannerOfRecord = loadConfig(ref.projectDir).config.planner;
    await rememberDetectedTools(
      ref.projectDir,
      cliDetectionsFor('ready', ['codex', 'claude-code']),
    );
    const state: WorkflowState = { ...capState(), phase: 'final-review' };
    saveState(ref, state);
    const { bus } = makeBusRecorder();
    const review: FinalReviewResult = {
      state,
      verdict: null,
      fixWork: null,
      reviewText: '',
      reviewStatus: 'failed',
      failure: {
        kind: 'seat-blocked',
        diagnosis: diagnosePlannerCallFailure({
          err: new Error('Please sign in again'),
          label: 'Review failed',
          runner: config.planner,
          seat: 'review',
        }),
      },
    };
    const halted = await haltVerdictlessReview({
      wctx: makeWctx({ ...ref, config, bus }),
      state,
      review,
      setTrackedState: vi.fn(),
    });
    expect(halted?.pendingRecovery?.switchSeat).toMatchObject({
      seat: 'review',
      auto: { candidate: fallback },
    });
    expect(halted?.pendingRecovery?.details).toContain(
      'REVIEW = PLAN. Switching here gives REVIEW its own seat.',
    );
    if (halted === undefined) throw new Error('expected a REVIEW halt');
    const moved = await switchSeatAndPrepareResume({
      ...ref,
      state: halted,
      config,
      candidate: fallback,
      bus,
      policy: {
        purpose: 'resume',
        interaction: 'headless',
        allowRepoRunners: false,
        allowHooks: false,
        unverifiedAuth: 'denied',
      },
      signal: new AbortController().signal,
      prepare: async (input) => ({
        kind: 'prepared',
        execution: makePreparedExecution({
          ...ref,
          feature: state.feature,
          config: input.effectiveConfig ?? config,
          resumeState: halted,
        }),
      }),
    });
    expect(moved.kind).toBe('switched');
    if (moved.kind !== 'switched') throw new Error('expected a REVIEW switch');
    expect(moved.config.planner).toEqual(config.planner);
    const expectedReviewer = {
      kind: 'cli',
      ...fallback,
      fallback: { tool: 'codex', model: 'gpt-5-codex', effort: 'high' },
    };
    expect(moved.config.reviewer).toEqual(expectedReviewer);
    const recorded = loadConfig(ref.projectDir).config;
    expect(recorded.planner).toEqual(plannerOfRecord);
    expect(recorded.reviewer).toEqual(expectedReviewer);
    expect(moved.state.seatSwitches).toEqual([
      expect.objectContaining({ seat: 'review', auto: true }),
    ]);
  });

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
        return plainUserMessage('Keep the API');
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
      onPlannerReply: vi.fn(async () => plainUserMessage('Keep the API')),
    }).callbacks;
    const checks = vi.fn(() => ({ commands: [], declined: [], reason: 'No command is needed.' }));
    const reviewPrompts: string[] = [];
    const { bus, events } = makeBusRecorder();
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
        bus,
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
    expect(events.filter((event) => event.type === 'review_step')).toEqual([
      expect.objectContaining({ step: 'choosing-checks' }),
      expect.objectContaining({ step: 'verdict' }),
      expect.objectContaining({ step: 'verdict' }),
    ]);
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
      comment: plainUserMessage('Keep the reviewed correction'),
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
      comment: plainUserMessage('Reviewed the diff by hand.'),
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

describe('scheduled review steering', () => {
  it.each([false, true])(
    'forwards the run port to each scheduled verdict with separateReviewer=%s',
    async (separateReviewer) => {
      const ref = setupProject();
      const done = makeTask({ id: 'T001', status: 'done' });
      const state = makeImplState([done, makeTask({ id: 'T002' })], {
        currentTaskIndex: 1,
        changedFilesBaseline: { head: null, fingerprints: {}, runStartChangedFiles: [] },
      });
      saveState(ref, state);
      writeEvidenceLedger(
        ref,
        createEvidenceLedger({
          sessionId: ref.sessionId,
          feature: state.feature,
          tasks: state.tasks,
        }),
      );
      const steering = createSteeringPort();
      const calls: Array<{ context: TypedCallContext; schemaName: string | undefined }> = [];
      const typedCall = typedCallPlanAndReview(
        () => planFromTasks([]),
        (prompt, call) => ({
          ...passingReviewVerdict(prompt),
          ...(call === 1
            ? { ask: { question: 'Keep the API?', whyOnlyUserCanAnswer: 'The API is public.' } }
            : { rejected: [{ findingId: 'A1', reason: 'Keep the approved API.' }] }),
        }),
      );
      const reviewer = makePlanner({
        typedCall: (ctx) => {
          const call = typedCall(ctx);
          return {
            ...call,
            invoke: (input) => {
              calls.push({ context: ctx, schemaName: input.schema?.name });
              return call.invoke(input);
            },
          };
        },
      });
      const callbacks = makeCallbacks({
        onPlannerReply: vi.fn().mockResolvedValue(plainUserMessage('Keep the API')),
      }).callbacks;
      const wctx = makeWctx({
        ...ref,
        steering,
        callbacks,
        planner: separateReviewer ? makePlanner() : reviewer,
        reviewer,
        config: makeNoValidationConfig({
          workflow: { review: 'task' },
          validation: { endChecks: true },
          ...(separateReviewer && { reviewer: { kind: 'cli', tool: 'claude-code' } }),
        }),
      });

      const result = await runScheduledReview({
        wctx,
        state,
        callbacks,
        afterTaskId: done.id,
        setTrackedState: vi.fn(),
      });

      expect(result.status).toBe('continue');
      expect(result.state.pendingScheduledReview).toBeUndefined();
      expect(callbacks.onPlannerReply).toHaveBeenCalledOnce();
      const verdicts = calls.filter((call) => call.schemaName === 'review_answer');
      expect(verdicts).toHaveLength(2);
      for (const call of verdicts) expect(call.context.callbacks.steering).toBe(steering);
      const helpers = calls.filter((call) => call.schemaName === 'review_checks');
      expect(helpers).toHaveLength(1);
      expect(helpers[0]?.context.callbacks).not.toHaveProperty('steering');
    },
  );
});
