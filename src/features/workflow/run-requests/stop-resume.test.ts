import { plainUserMessage } from '../../../core/types/user-input.js';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { renderInputMode } from '#testing/helpers/input-mode.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { Config } from '../../../core/schemas/config.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import { taskId } from '../../../core/schemas/task.js';
import {
  clearAllHandlers,
  createAbortHandlerScope,
  setStopHandler,
  setCancelHandler,
  setResumeHandler,
} from './registry.js';
import {
  consumeBoundaryInterrupt,
  consumeBoundaryPause,
  requestBoundaryPause,
} from './boundary.js';
import { requestResume, requestSteer, requestStopNow, resumeParkedRun } from './stop-resume.js';
import { requestEndRun } from './end-run.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { configStore } from '../../../stores/project/config.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { eventsStore } from '../../../stores/workflow/events/state.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { buildPromptCallbacks } from '../run-loop/prompt-callbacks.js';
import { plainAnswer } from '../hooks/use-input-mode.js';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { questionPromptStore } from '../../../stores/prompts/question.js';

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

  it('announces the stop and drops a pending pause before it calls the stop handler', () => {
    requestBoundaryPause();
    const seen: unknown[] = [];
    setStopHandler(() => {
      seen.push(stopStore.get().intent, consumeBoundaryPause());
    });

    expect(requestStopNow()).toBe(true);
    expect(seen).toEqual(['stop-now', undefined]);
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
