import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainUserMessage } from '../../core/types/user-input.js';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { renderInputMode } from '#testing/helpers/input-mode.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { STATE_FILE, sessionDir } from '../../core/paths.js';
import type { Config } from '../../core/schemas/config.js';
import type { StepRef } from '../../core/schemas/run-step.js';
import { taskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow/state.js';
import {
  activeApply,
  trackActiveApply,
} from '../../engine/orchestrator/session-lifecycle/shutdown.js';
import * as handlers from './run-requests/handlers.js';
import {
  abortTurn,
  cancelBoundaryPause,
  clearAllHandlers,
  consumeBoundaryInterrupt,
  consumeBoundaryPause,
  createAbortHandlerScope,
  landBoundaryPause,
  requestBoundaryPause,
  requestQuit,
  requestLeaveSession,
  setStopHandler,
  requestResume,
  requestSeatChangeAtBoundary,
  requestSteer,
  requestStopNow,
  requestClearQueue,
  resumeParkedRun,
  setCancelHandler,
  setClearQueueHandler,
  setResumeHandler,
  spendSeatChange,
} from './run-requests/handlers.js';
import { requestEndRun } from './run-requests/end-run.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle/state.js';
import { configStore } from '../../stores/project/config.js';
import { runViewStore } from '../../stores/workflow/run-view.js';
import { eventsStore } from '../../stores/workflow/events/state.js';
import { routerStore } from '../../stores/navigation/router.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { stopStore } from '../../stores/workflow/stop.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import {
  __testDiscardPending,
  draftRefusalStore,
  loadSessionDraft,
  saveSessionDraft,
} from '../../stores/ui/session-drafts.js';
import { markCancellationRequested } from '../../stores/workflow/actions/interrupt.js';
import { loadEvents } from '../../stores/workflow/actions/load.js';
import { createDraftDocument } from '../../core/composer/document.js';
import { writeSessionDraft } from '../../core/sessions/draft.js';
import { installDiagnosticSink } from '../../lib/warn.js';
import { buildPromptCallbacks } from './run-loop/prompt-callbacks.js';
import { plainAnswer } from './hooks/use-input-mode.js';
import type { ApprovalReviewResult } from '../../core/approval/types.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { questionPromptStore } from '../../stores/prompts/question.js';

describe('createAbortHandlerScope', () => {
  afterEach(() => {
    clearAllHandlers();
  });

  it('abort handlers stack LIFO within a scope', () => {
    const setAbortHandler = createAbortHandlerScope();
    const outer = vi.fn();
    const inner = vi.fn();
    setAbortHandler(outer);
    setAbortHandler(inner);

    expect(abortTurn()).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    setAbortHandler(null);
    expect(abortTurn()).toBe(true);
    expect(outer).toHaveBeenCalledTimes(1);

    setAbortHandler(null);
    expect(abortTurn()).toBe(false);
  });

  it("a superseded scope's late pop cannot steal the next scope's handler", () => {
    const oldScope = createAbortHandlerScope();
    const oldHandler = vi.fn();
    oldScope(oldHandler);

    // Rewind: cleanup clears everything, then the next run opens its own scope
    // while the old run's aborted body is still settling.
    clearAllHandlers();
    const newScope = createAbortHandlerScope();
    const newHandler = vi.fn();
    newScope(newHandler);

    // The old body finally settles and issues its paired pop.
    oldScope(null);

    expect(abortTurn()).toBe(true);
    expect(newHandler).toHaveBeenCalledTimes(1);
    expect(oldHandler).not.toHaveBeenCalled();
  });
});

describe('requestStopNow', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    lifecycleStore.reset();
    eventsStore.reset();
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ status: 'running' });
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('stop now aborts an escalation call', () => {
    const abortEscalation = vi.fn();
    createAbortHandlerScope()(abortEscalation);

    expect(requestStopNow()).toBe(true);
    expect(abortEscalation).toHaveBeenCalledTimes(1);
    expect(stopStore.get()).toMatchObject({ intent: 'stop-now', phase: 'requested' });
    expect(lifecycleStore.get().cancelled).toBe(false);
  });

  it('flags the next boundary when no call is in flight', () => {
    const cancel = vi.fn();
    setCancelHandler(cancel);

    expect(requestStopNow()).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(consumeBoundaryInterrupt()).toBe(true);
  });

  it('announces no stop when there is nothing to stop', () => {
    expect(requestStopNow()).toBe(false);
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
  });
});

describe('requestBoundaryPause', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('hands the engine one pause and clears it on the way out', () => {
    requestBoundaryPause();

    expect(stopStore.get().intent).toBe('pause-after-brief');
    expect(consumeBoundaryPause()).toBe('pause');
    expect(consumeBoundaryPause()).toBeUndefined();
  });

  it('keeps running drops the pending pause', () => {
    requestBoundaryPause();
    cancelBoundaryPause();

    expect(consumeBoundaryPause()).toBeUndefined();
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
  });

  it('a seat change asks the engine for the boundary and arms no pause of the operator', () => {
    requestSeatChangeAtBoundary();

    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', seatChange: true });
    expect(consumeBoundaryPause()).toBe('seat-change');
  });

  it('spending a seat change leaves no boundary to stop at', () => {
    requestSeatChangeAtBoundary();
    spendSeatChange();

    expect(consumeBoundaryPause()).toBeUndefined();
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', seatChange: false });
  });

  it('a pause the operator asked for wins over a seat change', () => {
    requestBoundaryPause();
    requestSeatChangeAtBoundary();

    expect(consumeBoundaryPause()).toBe('pause');
  });

  it('spending a seat change keeps the pause the operator asked for', () => {
    requestBoundaryPause();
    requestSeatChangeAtBoundary();
    spendSeatChange();

    expect(stopStore.get().intent).toBe('pause-after-brief');
    expect(consumeBoundaryPause()).toBe('pause');
    expect(landBoundaryPause()).toBe('park');
  });

  it('keep running withdraws only the operator pause, and the seat change still waits', () => {
    requestBoundaryPause();
    requestSeatChangeAtBoundary();
    cancelBoundaryPause();

    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', seatChange: true });
    expect(landBoundaryPause()).toBe('continue');
  });

  it('a seat change waits for the engine until it is spent', () => {
    expect(typeof handlers.seatChangeWaits).toBe('function');
    expect(handlers.seatChangeWaits()).toBe(false);

    requestSeatChangeAtBoundary();
    expect(handlers.seatChangeWaits()).toBe(true);
    expect(handlers.seatChangeWaits()).toBe(true);

    spendSeatChange();
    expect(handlers.seatChangeWaits()).toBe(false);
  });

  it('a pause of the user wins over a seat change that waits', () => {
    expect(typeof handlers.seatChangeWaits).toBe('function');
    requestBoundaryPause();
    requestSeatChangeAtBoundary();

    expect(handlers.seatChangeWaits()).toBe(false);
    expect(consumeBoundaryPause()).toBe('pause');
  });

  it('lands the boundary pause as a park, a continue on the saved seats, or a stop the operator asked for', () => {
    requestBoundaryPause();
    expect(landBoundaryPause()).toBe('park');

    stopStore.__testReset();
    requestSeatChangeAtBoundary();
    expect(landBoundaryPause()).toBe('continue');
    expect(stopStore.get().seatChange).toBe(false);

    requestBoundaryPause();
    requestSeatChangeAtBoundary();
    expect(landBoundaryPause()).toBe('stop');
    expect(stopStore.get()).toMatchObject({ intent: 'pause-after-brief', seatChange: false });
  });
});

describe('requestEndRun', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    lifecycleStore.reset();
    eventsStore.reset();
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ status: 'running' });
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('cancels the run and records the intent', () => {
    const cancel = vi.fn();
    setCancelHandler(cancel);

    expect(requestEndRun()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(lifecycleStore.get().cancelled).toBe(true);
    expect(stopStore.get().intent).toBe('end-run');
  });
});

describe('requestResume', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
  });

  it('hands every continuation to the run, park or no park', () => {
    const resume = vi.fn(() => undefined);
    const steer = vi.fn();
    setResumeHandler(resume);
    stopStore.park('mid-brief', 'T002', steer);

    expect(requestResume(plainUserMessage('use the other adapter'))).toBeUndefined();
    expect(resume).toHaveBeenCalledWith(plainUserMessage('use the other adapter'));
    // The run decides what continuing means; nothing settles behind its back.
    expect(steer).not.toHaveBeenCalled();
  });

  it('reports nothing to resume when no run is on screen', () => {
    expect(requestResume(plainUserMessage(''))).toBe('Nothing to resume.');
  });

  it('returns the reason when the run refuses to continue', () => {
    setResumeHandler(() => 'No saved state to continue.');

    expect(requestResume(plainUserMessage(''))).toBe('No saved state to continue.');
    expect(feedbackStore.get().message).toBeNull();
  });

  it('returns the stop as the reason while the run stops, and shows no text itself', () => {
    const resume = vi.fn(() => undefined);
    setResumeHandler(resume);
    stopStore.request('stop-now');

    expect(requestResume(plainUserMessage(''))).toBe('Finish stopping before resuming.');
    expect(resume).not.toHaveBeenCalled();
    expect(feedbackStore.get().message).toBeNull();
  });

  it('refuses Resume after a failed stop until the stop is retried', () => {
    const resume = vi.fn(() => undefined);
    setResumeHandler(resume);
    setStopHandler(vi.fn());

    for (const intent of ['stop-now', 'pause-after-brief'] as const) {
      stopStore.__testReset();
      stopStore.request(intent);
      stopStore.fail('Disk full');

      expect(requestResume(plainUserMessage(''))).toBe('Finish stopping before resuming.');
      expect(resume).not.toHaveBeenCalled();

      expect(requestStopNow()).toBe(true);
      expect(stopStore.get()).toMatchObject({ intent: 'stop-now', phase: 'requested' });
      expect(requestResume(plainUserMessage(''))).toBe('Finish stopping before resuming.');
      expect(resume).not.toHaveBeenCalled();

      stopStore.park('mid-brief', 'T001', null);
      expect(requestResume(plainUserMessage(''))).toBeUndefined();
      expect(resume).toHaveBeenCalledExactlyOnceWith(plainUserMessage(''));
      resume.mockClear();
    }

    expect(feedbackStore.get().message).toBeNull();
  });

  it('lets an ended stop resume and steer without a finish-stopping reason', () => {
    const resume = vi.fn(() => undefined);
    setResumeHandler(resume);
    stopStore.request('stop-now');
    stopStore.end();
    const message = plainUserMessage('keep the greeting API');

    expect(requestResume(message)).toBeUndefined();
    expect(requestSteer(message)).toBeUndefined();

    expect(resume).toHaveBeenNthCalledWith(1, message);
    expect(resume).toHaveBeenNthCalledWith(2, message);
    expect(feedbackStore.get().message).toBeNull();
  });

  it('requestResume refuses while a call runs and no park waits, and calls no resume handler', () => {
    const resume = vi.fn(() => undefined);
    const stop = vi.fn();
    setResumeHandler(resume);
    setStopHandler(stop);

    expect(requestResume(plainUserMessage(''))).toBe('Nothing to resume: the run has not stopped.');
    expect(resume).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
    expect(feedbackStore.get().message).toBeNull();
  });

  it('requestResume settles a park while the pass still holds its handlers', () => {
    const resume = vi.fn(() => undefined);
    setResumeHandler(resume);
    setStopHandler(vi.fn());
    stopStore.request('stop-now');
    stopStore.park('mid-brief', 'T001', vi.fn());

    expect(requestResume(plainUserMessage(''))).toBeUndefined();
    expect(resume).toHaveBeenCalledExactlyOnceWith(plainUserMessage(''));
  });
});

describe('resumeParkedRun', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('settles a parked brief with the typed steer', () => {
    const steer = vi.fn();
    stopStore.park('mid-brief', 'T002', steer);

    expect(resumeParkedRun(plainUserMessage('use the other adapter'))).toBe(true);
    expect(steer).toHaveBeenCalledWith(plainUserMessage('use the other adapter'));
    expect(stopStore.get().phase).toBe('idle');
  });

  it('settles a boundary park so the run starts the next brief', () => {
    const steer = vi.fn();
    stopStore.request('pause-after-brief');
    stopStore.park('boundary', 'T001', steer);

    expect(resumeParkedRun(plainUserMessage(''))).toBe(true);
    expect(steer).toHaveBeenCalledWith(plainUserMessage(''));
  });

  it('reports no park when the run is at rest', () => {
    expect(resumeParkedRun(plainUserMessage(''))).toBe(false);
  });

  it('leaves a resolverless park for the saved-state continuation', () => {
    stopStore.park('mid-brief', 'T001', null);

    expect(resumeParkedRun(plainUserMessage('keep the greeting API'))).toBe(false);
    expect(stopStore.get().phase).toBe('parked');
  });
});

describe('a boundary park of a REVIEW None pass after the last brief', () => {
  const dirs: string[] = [];
  const WORDS = plainUserMessage('also fix the typo');
  const REVIEW_STEP: StepRef = { kind: 'review', cycle: 0 };
  const BRIEF_STEP: StepRef = { kind: 'brief', taskId: taskId('T002'), attempt: 0 };

  const NONE = makeConfig({ reviewer: 'none' });
  const SEAT = makeConfig();

  function parkedAt(step: StepRef, config: Config): ReturnType<typeof vi.fn> {
    const projectDir = createTempDir('handlers-boundary-park-');
    dirs.push(projectDir);
    configStore.__testReset({ projectDir, config });
    runViewStore.__testReset({ stopStep: step });
    const settle = vi.fn();
    stopStore.park('boundary', 'T001', settle);
    return settle;
  }

  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    runViewStore.__testReset();
    configStore.__testReset();
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  it.each<[string, StepRef]>([
    ['Apply', { kind: 'apply' }],
    ['the review', REVIEW_STEP],
  ])('keeps the park for words typed at %s: no step reads them', (_, step) => {
    const settle = parkedAt(step, NONE);

    expect(resumeParkedRun(WORDS)).toBe(false);
    expect(settle).not.toHaveBeenCalled();
    expect(stopStore.get().phase).toBe('parked');
  });

  it('sends a steer to the resume handler, and returns its refusal of the words', () => {
    const settle = parkedAt(REVIEW_STEP, NONE);
    const refusal = 'Cannot send words to the review. Clear them.';
    const resume = vi.fn(() => refusal);
    setResumeHandler(resume);

    expect(requestSteer(WORDS)).toBe(refusal);
    expect(settle).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledExactlyOnceWith(WORDS);
  });

  it('settles on a bare Enter', () => {
    const settle = parkedAt(REVIEW_STEP, NONE);

    expect(resumeParkedRun(plainUserMessage(''))).toBe(true);
    expect(settle).toHaveBeenCalledExactlyOnceWith(plainUserMessage(''));
  });

  it.each<[string, StepRef, Config]>([
    ['a brief that is next under REVIEW None', BRIEF_STEP, NONE],
    ['a review a seat runs', REVIEW_STEP, SEAT],
  ])('settles with the words at %s: the step reads them', (_, step, config) => {
    const settle = parkedAt(step, config);

    expect(resumeParkedRun(WORDS)).toBe(true);
    expect(settle).toHaveBeenCalledExactlyOnceWith(WORDS);
  });
});

describe('requestSteer', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    reviewStore.reset();
    questionPromptStore.reset();
    feedbackStore.reset();
  });

  // The review that the run opens, held until the test settles it.
  function openReview(type: 'plan' | 'artifact') {
    const held = Promise.withResolvers<ApprovalReviewResult>();
    const resolve = vi.fn<(value: unknown) => void>();
    const review = buildPromptCallbacks({
      inputMode: {
        mode: 'review',
        hint: '',
        questionEpoch: 0,
        setReviewMode: () => held.promise,
        setQuestionMode: async () => plainAnswer(''),
        resolve,
        resetMode: () => {},
      },
      abortedRef: { current: false },
      controller: new AbortController(),
    }).onApprovalNeeded(type, type === 'plan' ? '/tmp/plan.md' : { label: 'a', text: 'b' }, []);
    return {
      resolve,
      settle: async () => {
        held.resolve({ approved: false });
        await review;
      },
    };
  }

  // The planner question that the run asks, through the input mode that the screen renders.
  async function openQuestion() {
    const { inputMode, mode, unmount } = await renderInputMode();
    onTestFinished(unmount);
    const answered = buildPromptCallbacks({
      inputMode,
      abortedRef: { current: false },
      controller: new AbortController(),
    }).onPlannerReply?.({
      call: 'plan',
      text: '',
      questions: [{ id: 'numbers', type: 'input', text: 'Which numbers?' }],
      answers: [],
      answered: false,
    });
    await vi.waitFor(() => expect(mode()).toBe('question'));
    return { inputMode, answered };
  }

  it('sends the words to the waiting planner question as its answer and stops nothing', async () => {
    const stop = vi.fn();
    const abort = vi.fn();
    setStopHandler(stop);
    createAbortHandlerScope()(abort);
    const question = await openQuestion();
    const message = plainUserMessage('also fix the typo');

    const refusal = requestSteer(message);

    expect(abort).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(stopStore.get().intent).toBe('none');
    expect(refusal).toBeUndefined();
    await expect(question.answered).resolves.toEqual(message);
  });

  it('stops the run with a steer once the planner question is answered', async () => {
    const stop = vi.fn();
    setStopHandler(stop);
    const question = await openQuestion();
    question.inputMode.resolve(plainAnswer('Integers only'));
    await expect(question.answered).resolves.toEqual(plainUserMessage('Integers only'));

    expect(requestSteer(plainUserMessage('smaller diffs'))).toBeUndefined();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('returns the reason when the run refuses to continue with the words', () => {
    const refusal =
      'Cannot continue: this run is ready to apply; choose Apply or Discard (/run accept, /run reject confirm).';
    setResumeHandler(() => refusal);

    expect(requestSteer(plainUserMessage('also fix the typo'))).toBe(refusal);
    expect(feedbackStore.get().message).toBeNull();
  });

  it('returns the stop as the one reason while the run stops, and shows no text itself', () => {
    const stop = vi.fn();
    setStopHandler(stop);
    expect(requestStopNow()).toBe(true);

    expect(requestSteer(plainUserMessage('also fix the typo'))).toBe(
      'Finish stopping before steering.',
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(feedbackStore.get().message).toBeNull();
  });

  it('shows the reason when the run refuses the words after the stop parked, in the neutral voice', () => {
    const refusal = 'No saved state to continue.';
    setStopHandler(vi.fn());
    setResumeHandler(() => refusal);

    expect(requestSteer(plainUserMessage('also fix the typo'))).toBeUndefined();
    stopStore.park('mid-brief', 'T001', null);

    expect(feedbackStore.get()).toEqual({ message: refusal, isError: false });
  });

  it('sends the words to the waiting plan card as its change request and stops nothing', async () => {
    const stop = vi.fn();
    setStopHandler(stop);
    const card = openReview('plan');
    const message = plainUserMessage('also fix the typo');

    expect(requestSteer(message)).toBeUndefined();

    expect(card.resolve).toHaveBeenCalledExactlyOnceWith({
      approved: false,
      action: 'revise',
      message,
    });
    expect(stop).not.toHaveBeenCalled();
    expect(stopStore.get().intent).toBe('none');
    await card.settle();
  });

  it('keeps a newer plan card open to a steer when the older one settles after it opened', async () => {
    const stop = vi.fn();
    setStopHandler(stop);
    const older = openReview('plan');
    const newer = openReview('plan');
    await older.settle();
    const message = plainUserMessage('also fix the typo');

    expect(requestSteer(message)).toBeUndefined();

    expect(newer.resolve).toHaveBeenCalledExactlyOnceWith({
      approved: false,
      action: 'revise',
      message,
    });
    expect(older.resolve).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    await newer.settle();
  });

  it('stops the run with a steer once the plan card is answered', async () => {
    const stop = vi.fn();
    setStopHandler(stop);
    const card = openReview('plan');
    await card.settle();

    expect(requestSteer(plainUserMessage('smaller diffs'))).toBeUndefined();

    expect(card.resolve).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops the run with a steer over a review that is not the plan card', async () => {
    const stop = vi.fn();
    setStopHandler(stop);
    const review = openReview('artifact');

    expect(requestSteer(plainUserMessage('smaller diffs'))).toBeUndefined();

    expect(review.resolve).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    await review.settle();
  });

  it('stops now and holds the text until the park lands', () => {
    const stop = vi.fn();
    setStopHandler(stop);

    expect(requestSteer(plainUserMessage('smaller diffs'))).toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);

    // The text survives the stop race: the park that follows resumes with it.
    const steer = vi.fn();
    stopStore.park('mid-brief', 'T002', steer);
    expect(steer).toHaveBeenCalledWith(plainUserMessage('smaller diffs'));
  });

  it('continues a run already parked with the text', () => {
    const steer = vi.fn();
    stopStore.park('mid-brief', 'T002', steer);

    expect(requestSteer(plainUserMessage('use the other adapter'))).toBeUndefined();
    expect(steer).toHaveBeenCalledWith(plainUserMessage('use the other adapter'));
  });

  it('reports nothing to steer when no run is on screen', () => {
    expect(requestSteer(plainUserMessage('nope'))).toBe('Nothing to steer.');
    expect(feedbackStore.get().message).toBeNull();
  });

  it('reports nothing to steer for a steer with no words', () => {
    setResumeHandler(vi.fn(() => undefined));

    expect(requestSteer(plainUserMessage('  '))).toBe('Nothing to steer.');
  });

  it('hands a resolverless park to the run continuation with its attachments', () => {
    const resume = vi.fn(() => undefined);
    setResumeHandler(resume);
    stopStore.park('mid-brief', 'T001', null);
    const message = {
      ...plainUserMessage('keep the greeting API'),
      attachedInputs: [{ path: '/tmp/send-now-note.md', kind: 'text' as const }],
    };

    expect(requestSteer(message)).toBeUndefined();
    expect(resume).toHaveBeenCalledExactlyOnceWith(message);
  });

  it.each([
    ['stop', requestStopNow],
    ['end run', requestEndRun],
  ] as const)('an explicit %s supersedes a pending steer', (_name, stop) => {
    runViewStore.__testReset({ phase: 'implementing' });
    lifecycleStore.__testReset({ cancelled: false });
    setStopHandler(vi.fn());
    setCancelHandler(vi.fn());
    createAbortHandlerScope()(vi.fn());
    expect(requestSteer(plainUserMessage('keep the greeting API'))).toBeUndefined();

    expect(stop()).toBe(true);
    const resolve = vi.fn();
    stopStore.park('mid-brief', 'T001', resolve);

    expect(resolve).not.toHaveBeenCalled();
    expect(stopStore.get().phase).toBe('parked');
  });

  it('delivers the steer exactly once when the stop parks synchronously', () => {
    const resolve = vi.fn();
    setStopHandler(() => stopStore.park('mid-brief', 'T001', resolve));
    const message = plainUserMessage('keep the greeting API');

    expect(requestSteer(message)).toBeUndefined();
    expect(resolve).toHaveBeenCalledExactlyOnceWith(message);
    expect(stopStore.get().phase).toBe('idle');
  });
});

describe('requestQuit', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('exits at once when there is no run to stop', () => {
    const exit = vi.fn();

    requestQuit(exit);

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('waits for the run to park before leaving', () => {
    const exit = vi.fn();
    createAbortHandlerScope()(vi.fn());

    requestQuit(exit);
    expect(exit).not.toHaveBeenCalled();

    stopStore.park('mid-brief', 'T002', null);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('departure with an unsent draft that cannot be saved', () => {
  let projectDir: string;
  let dir: string;
  let releaseSink: () => void;
  const run = () => makeRunRecord({ ref: ref() });
  const openRun = () =>
    routerStore.init({ screen: 'workflow', run: run(), execution: { kind: 'at-rest' } });
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    eventsStore.reset();
    lifecycleStore.reset();
    projectDir = createTempDir('handlers-draft-');
    dir = sessionDir(projectDir, 'one');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    openRun();
    releaseSink = installDiagnosticSink(() => {});
  });
  afterEach(() => {
    releaseSink();
    chmodSync(dir, 0o755);
    __testDiscardPending();
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    routerStore.reset();
    cleanupTempDir(projectDir);
  });

  const ref = () => ({ projectDir, sessionId: 'one' });
  const CAUSE = 'Draft not saved: permission denied · .splitbrief/sessions/one/draft.json';
  const HINT = { message: 'Draft not saved · esc or quit again leaves without it', isError: true };

  it('names the cause and the file once, then leaves without it on the next quit', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('unsent words'));

    requestQuit(exit);
    expect(exit).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toEqual(HINT);
    expect(draftRefusalStore.get()?.message).toBe(CAUSE);
    expect(eventsStore.get().events).toEqual([]);

    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(loadSessionDraft(ref())).toEqual(createDraftDocument(''));
    expect(draftRefusalStore.get()).toBeNull();
  });

  it('holds a later leave again once a save in between landed', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('first words'));
    requestQuit(exit);
    chmodSync(dir, 0o755);
    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);

    chmodSync(dir, 0o555);
    feedbackStore.reset();
    saveSessionDraft(ref(), createDraftDocument('second words'));
    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(feedbackStore.get()).toEqual(HINT);
  });

  it('leaves on the second quit after a re-read of the same run replaced its route', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('unsent words'));
    requestQuit(exit);
    routerStore.updateRun({ run: run(), execution: { kind: 'at-rest' } });

    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('holds again when the same run is opened again before the next quit', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('unsent words'));
    requestQuit(exit);
    routerStore.navigate({ to: 'home' });
    routerStore.navigate({ to: 'workflow', run: run(), execution: { kind: 'at-rest' } });

    requestQuit(exit);
    expect(exit).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toEqual(HINT);
  });

  it('keeps the cause and the file after End run when the at-rest re-read replaces the log', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('unsent words'));
    markCancellationRequested();
    requestQuit(exit);
    loadEvents([]);

    expect(exit).not.toHaveBeenCalled();
    expect(draftRefusalStore.get()?.message).toBe(CAUSE);
  });

  it('names the cause and the file on home and says a second quit leaves without it', () => {
    const exit = vi.fn();
    saveSessionDraft(ref(), createDraftDocument('unsent words'));
    routerStore.navigate({ to: 'home' });

    requestQuit(exit);
    expect(exit).not.toHaveBeenCalled();
    expect(feedbackStore.get()).toEqual({
      message: `${CAUSE} · quit again leaves without it`,
      isError: true,
    });

    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('leaving with an empty composer over an old draft that cannot be removed', () => {
  let projectDir: string;
  let dir: string;
  const ref = () => ({ projectDir, sessionId: 'one' });
  const NOTE =
    'Could not remove the old draft: permission denied · .splitbrief/sessions/one/draft.json · its text comes back when you restart SPLITBRIEF and open that run';
  let diagnostics: { message: string; presentation: string }[];
  let releaseSink: () => void;

  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    projectDir = createTempDir('handlers-draft-unremovable-');
    dir = sessionDir(projectDir, 'one');
    writeSessionDraft(ref(), createDraftDocument('my unsent draft'));
    chmodSync(dir, 0o555);
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: ref() }),
      execution: { kind: 'at-rest' },
    });
    saveSessionDraft(ref(), createDraftDocument(''));
    diagnostics = [];
    releaseSink = installDiagnosticSink((message, presentation) =>
      diagnostics.push({ message, presentation }),
    );
  });
  afterEach(() => {
    releaseSink();
    chmodSync(dir, 0o755);
    __testDiscardPending();
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    routerStore.reset();
    cleanupTempDir(projectDir);
  });

  it.each([
    [
      'esc, Back to sessions',
      () => {
        requestLeaveSession();
        return routerStore.get().screen === 'home';
      },
    ],
    [
      'ctrl+c, /quit',
      () => {
        const exit = vi.fn();
        requestQuit(exit);
        return exit.mock.calls.length === 1;
      },
    ],
  ])('%s leaves on the first press', (_name, leave) => {
    expect(leave()).toBe(true);
    expect(draftRefusalStore.get()).toBeNull();
    expect(feedbackStore.get().message ?? '').not.toContain('Draft not saved');
  });

  it('names the file on home after esc', () => {
    requestLeaveSession();
    expect(routerStore.get().screen).toBe('home');
    expect(feedbackStore.get()).toEqual({ message: NOTE, isError: true });
  });

  it('names the file on stderr once the terminal is restored after a quit', () => {
    const exit = vi.fn();
    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([
      { message: NOTE, presentation: 'at-exit' },
      { message: 'Continue this run with: splitbrief continue one', presentation: 'at-exit' },
    ]);
  });
});

describe('consumeBoundaryInterrupt', () => {
  beforeEach(() => {
    clearAllHandlers();
    lifecycleStore.reset();
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ status: 'running' });
  });

  afterEach(() => {
    clearAllHandlers();
  });

  it('consumeBoundaryInterrupt reads and clears the pending flag', () => {
    expect(consumeBoundaryInterrupt()).toBe(false);

    setCancelHandler(vi.fn());
    requestStopNow();

    expect(consumeBoundaryInterrupt()).toBe(true);
    expect(consumeBoundaryInterrupt()).toBe(false);
  });
});

describe('requestClearQueue', () => {
  beforeEach(() => {
    clearAllHandlers();
    lifecycleStore.reset();
    eventsStore.reset();
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ queueDepth: 2, status: 'running' });
  });

  afterEach(() => {
    clearAllHandlers();
  });

  it('returns unavailable and does not mutate lifecycle or events when no handler exists', () => {
    expect(requestClearQueue()).toEqual({
      status: 'unavailable',
      message: 'Queue clear is not available for this workflow.',
    });
    expect(lifecycleStore.get().queueDepth).toBe(2);
    expect(eventsStore.get().events).toEqual([]);
  });

  it('delegates to the registered clear handler', () => {
    const clear = vi.fn(() => ({ status: 'cleared' as const, count: 2 }));
    setClearQueueHandler(clear);

    expect(requestClearQueue()).toEqual({ status: 'cleared', count: 2 });
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe('safe departure', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.reset();
    routerStore.reset();
  });
  afterEach(() => {
    clearAllHandlers();
    stopStore.reset();
    routerStore.reset();
  });

  it('observes a synchronous stop and invokes exit exactly once', () => {
    const stop = vi.fn(() => stopStore.park('mid-brief', null, null));
    setStopHandler(stop);
    const exit = vi.fn();
    requestQuit(exit);
    stopStore.end();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('keeps one stop request while quit supersedes pending home', () => {
    const stop = vi.fn();
    setStopHandler(stop);
    const exit = vi.fn();
    const home = vi.spyOn(routerStore, 'navigate');
    requestStopNow();
    const requestedAt = stopStore.get().requestedAt;
    requestLeaveSession();
    requestQuit(exit);
    requestQuit(exit);
    requestLeaveSession();
    expect(exit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopStore.get().requestedAt).toBe(requestedAt);
    stopStore.park('mid-brief', null, null);
    expect(home).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    home.mockRestore();
  });

  it('unwinds a boundary promise before delivering exit', () => {
    stopStore.request('pause-after-brief');
    const resolve = vi.fn();
    stopStore.park('boundary', 'T001', resolve);
    const stop = vi.fn(() => stopStore.get().parked?.resolve?.(plainUserMessage('')));
    setStopHandler(stop);
    const exit = vi.fn();
    requestQuit(exit);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    stopStore.park('boundary', 'T001', null);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('cancels departure on a failed save and retries the original explicit end intent', () => {
    const stop = vi.fn();
    setStopHandler(stop);
    stopStore.request('end-run');
    const exit = vi.fn();
    requestQuit(exit);
    stopStore.fail('Disk full');
    expect(exit).not.toHaveBeenCalled();
    expect(requestStopNow()).toBe(true);
    expect(stopStore.get()).toMatchObject({ intent: 'end-run', phase: 'requested' });
    expect(stopStore.get().error).toBeUndefined();
    stopStore.end();
    expect(exit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not deliver stale departure after changing sessions', () => {
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir: '/tmp', sessionId: 'first' } }),
      execution: { kind: 'at-rest' },
    });
    setStopHandler(vi.fn());
    const exit = vi.fn();
    requestQuit(exit);
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir: '/tmp', sessionId: 'second' } }),
      execution: { kind: 'at-rest' },
    });
    stopStore.park('mid-brief', null, null);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('departure while this process applies the run at rest', () => {
  const sessionId = 'applying-run';
  const at = '2026-10-19T00:00:00.000Z';
  let projectDir = '';
  let settle: (state: WorkflowState) => Promise<void> = async () => {};
  let diagnostics: { message: string; presentation: string }[];
  let releaseSink: () => void;

  const readyState = (): WorkflowState =>
    makeWorkflowState({
      phase: 'complete',
      reviewStatus: 'passed',
      workspace: {
        kind: 'staged-copy',
        path: '/tmp/run-workspace',
        base: { snapshotId: 'workspace-base', head: null },
      },
    });
  const appliedState = (): WorkflowState => ({
    ...readyState(),
    applied: { at, backupId: 'backup-1', files: ['a.txt'] },
    closed: { at, as: 'applied' },
  });

  function saveState(state: WorkflowState): void {
    writeFileSync(join(sessionDir(projectDir, sessionId), STATE_FILE), JSON.stringify(state));
  }

  beforeEach(() => {
    clearAllHandlers();
    stopStore.reset();
    projectDir = createTempDir('handlers-apply');
    mkdirSync(sessionDir(projectDir, sessionId), { recursive: true });
    saveState(readyState());
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir, sessionId }, status: { kind: 'running' } }),
      execution: { kind: 'at-rest' },
    });
    const apply = Promise.withResolvers<void>();
    void trackActiveApply(apply.promise);
    settle = async (state) => {
      saveState(state);
      apply.resolve();
      await activeApply();
      await new Promise((resolve) => setImmediate(resolve));
    };
    diagnostics = [];
    releaseSink = installDiagnosticSink((message, presentation) =>
      diagnostics.push({ message, presentation }),
    );
  });

  afterEach(async () => {
    await settle(readyState());
    releaseSink();
    clearAllHandlers();
    stopStore.reset();
    routerStore.reset();
    cleanupTempDir(projectDir);
  });

  it('queues a quit until the Apply settles, then quits once', async () => {
    const exit = vi.fn();

    requestQuit(exit);
    requestQuit(exit);
    expect(exit).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([]);

    await settle(readyState());
    expect(exit).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([
      {
        message: 'Continue this run with: splitbrief continue applying-run',
        presentation: 'at-exit',
      },
    ]);
  });

  it('goes home once the Apply settles with the run applied', async () => {
    requestLeaveSession();
    requestLeaveSession();
    expect(routerStore.get().screen).toBe('workflow');

    await settle(appliedState());
    expect(routerStore.get().screen).toBe('home');
  });

  it('drops a queued home and stays on the run when the Apply did not apply it', async () => {
    requestLeaveSession();

    await settle(readyState());
    expect(routerStore.get().screen).toBe('workflow');
  });

  it('lets a quit replace a queued home, and a later Esc changes nothing', async () => {
    const exit = vi.fn();

    requestLeaveSession();
    requestQuit(exit);
    requestLeaveSession();
    expect(exit).not.toHaveBeenCalled();

    await settle(readyState());
    expect(exit).toHaveBeenCalledTimes(1);
    expect(routerStore.get().screen).toBe('workflow');
  });

  it('keeps a home queued behind the Apply when the run loop that drove it tears down', async () => {
    requestLeaveSession();
    clearAllHandlers();

    await settle(appliedState());
    expect(routerStore.get().screen).toBe('home');
  });
});

describe('a quit names the command that continues the run', () => {
  const sessionId = 'resumable-run';
  let projectDir: string;
  let diagnostics: { message: string; presentation: string }[];
  let releaseSink: () => void;

  function saveState(state: WorkflowState): void {
    writeFileSync(join(sessionDir(projectDir, sessionId), STATE_FILE), JSON.stringify(state));
  }

  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    projectDir = createTempDir('handlers-quit-continue-');
    mkdirSync(sessionDir(projectDir, sessionId), { recursive: true });
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir, sessionId } }),
      execution: { kind: 'at-rest' },
    });
    diagnostics = [];
    releaseSink = installDiagnosticSink((message, presentation) =>
      diagnostics.push({ message, presentation }),
    );
  });

  afterEach(() => {
    releaseSink();
    clearAllHandlers();
    stopStore.__testReset();
    feedbackStore.reset();
    routerStore.reset();
    cleanupTempDir(projectDir);
  });

  it.each([
    [
      'stopped',
      makeWorkflowState({
        phase: 'implementing',
        interruptedStep: {
          step: { kind: 'review', cycle: 0 },
          source: 'user',
          cut: 'boundary',
          at: '2026-10-19T00:00:00.000Z',
        },
      }),
    ],
    [
      'halted',
      makeWorkflowState({
        phase: 'implementing',
        pendingRecovery: makeRecoveryIssue(),
      }),
    ],
    [
      'waiting for an answer',
      makeWorkflowState({
        phase: 'planning',
        pendingPlannerConversation: {
          call: 'plan',
          text: 'Which DB?',
          questions: [],
          answers: [],
          answered: false,
        },
      }),
    ],
    [
      'ready to apply',
      makeWorkflowState({
        phase: 'complete',
        reviewStatus: 'passed',
        workspace: {
          kind: 'staged-copy',
          path: '/tmp/run-workspace',
          base: { snapshotId: 'workspace-base', head: null },
        },
      }),
    ],
  ] as const)('names the continue command on stderr after a quit from a %s run', (_name, state) => {
    saveState(state);
    const exit = vi.fn();
    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([
      {
        message: `Continue this run with: splitbrief continue ${sessionId}`,
        presentation: 'at-exit',
      },
    ]);
  });

  it('writes no continue line after a quit from a closed run', () => {
    for (const as of ['applied', 'ended'] as const) {
      diagnostics = [];
      saveState(
        makeWorkflowState({
          closed: { at: '2026-10-19T00:00:00.000Z', as },
        }),
      );
      const exit = vi.fn();
      requestQuit(exit);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(diagnostics).toEqual([]);
    }
  });

  it('writes no continue line after a quit from home', () => {
    routerStore.navigate({ to: 'home' });
    const exit = vi.fn();
    requestQuit(exit);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([]);
  });

  it('names an old draft before the continue line', () => {
    const dir = sessionDir(projectDir, sessionId);
    writeSessionDraft({ projectDir, sessionId }, createDraftDocument('my unsent draft'));
    chmodSync(dir, 0o555);
    try {
      saveSessionDraft({ projectDir, sessionId }, createDraftDocument(''));
      const exit = vi.fn();
      requestQuit(exit);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(diagnostics).toEqual([
        {
          message: `Could not remove the old draft: permission denied · .splitbrief/sessions/${sessionId}/draft.json · its text comes back when you restart SPLITBRIEF and open that run`,
          presentation: 'at-exit',
        },
        {
          message: `Continue this run with: splitbrief continue ${sessionId}`,
          presentation: 'at-exit',
        },
      ]);
    } finally {
      chmodSync(dir, 0o755);
      __testDiscardPending();
    }
  });
});
