import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPromptCallbacks } from './prompt-callbacks.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { stopStore } from '../../stores/workflow/stop.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { reviewStore } from '../../stores/workflow/review.js';
import {
  closeReviewChecksPrompt,
  reviewChecksPromptStore,
} from '../../stores/review-checks-prompt/prompt.js';

function makeInputMode(answers: string | string[]): UseInputModeResult {
  const queue = Array.isArray(answers) ? [...answers] : [answers];
  return {
    mode: 'normal',
    hint: '',
    questionEpoch: 0,
    setReviewMode: async () => ({ approved: false }),
    setQuestionMode: async () => queue.shift() ?? '',
    resolve: () => {},
    resetMode: () => {},
  };
}

function makeCallbacks(answers: string | string[]) {
  return makeCallbacksWithInputMode(makeInputMode(answers));
}

function makeCallbacksWithInputMode(inputMode: UseInputModeResult) {
  return buildPromptCallbacks({
    inputMode,
    abortedRef: { current: false },
    controller: new AbortController(),
  });
}

describe('buildPromptCallbacks onApprovalNeeded', () => {
  afterEach(() => {
    reviewStore.reset();
  });

  it.each(['plan', 'artifact'] as const)(
    'uses the generic review hint for %s approvals',
    async (type) => {
      const setReviewMode = vi
        .fn<UseInputModeResult['setReviewMode']>()
        .mockResolvedValue({ approved: false });
      const callbacks = makeCallbacksWithInputMode({
        ...makeInputMode(''),
        setReviewMode,
      });

      await callbacks.onApprovalNeeded(type, '/tmp/review.md', []);

      expect(setReviewMode).toHaveBeenCalledWith('');
    },
  );

  it('lists what the engine says approving the plan card confirms, not what a file says', async () => {
    const setReviewMode = vi
      .fn<UseInputModeResult['setReviewMode']>()
      .mockImplementation(async () => {
        expect(reviewStore.get().confirms).toEqual(['write package.json']);
        return { approved: true };
      });
    const callbacks = makeCallbacksWithInputMode({ ...makeInputMode(''), setReviewMode });

    await callbacks.onApprovalNeeded('plan', '/nonexistent/plan.md', ['write package.json']);

    expect(setReviewMode).toHaveBeenCalledOnce();
  });

  it('replaces the confirms on a revised plan card and clears them for an artifact review', async () => {
    const seen: (readonly string[])[] = [];
    const setReviewMode = vi
      .fn<UseInputModeResult['setReviewMode']>()
      .mockImplementation(async () => {
        seen.push(reviewStore.get().confirms);
        return { approved: false, action: 'revise', comment: 'split T002' };
      });
    const callbacks = makeCallbacksWithInputMode({ ...makeInputMode(''), setReviewMode });

    await callbacks.onApprovalNeeded('plan', '/nonexistent/plan.md', ['write package.json']);
    await callbacks.onApprovalNeeded('plan', '/nonexistent/plan.md', [
      'write package.json',
      'write package-lock.json',
    ]);
    await callbacks.onApprovalNeeded('artifact', { label: 'Artifact', text: 'text' }, []);

    expect(seen).toEqual([
      ['write package.json'],
      ['write package.json', 'write package-lock.json'],
      [],
    ]);
    expect(reviewStore.get().confirms).toEqual([]);
  });

  it('uses the frozen artifact text without retaining its display label as a path', async () => {
    const review = Object.freeze({
      label: 'Custom planner artifact',
      text: 'finalized artifact text',
    });
    const setReviewMode = vi
      .fn<UseInputModeResult['setReviewMode']>()
      .mockImplementation(async (hint) => {
        expect(hint).toBe('');
        expect(reviewStore.get()).toMatchObject({
          source: { kind: 'artifact', text: review.text },
          filePath: null,
        });
        return { approved: true };
      });
    const callbacks = makeCallbacksWithInputMode({
      ...makeInputMode(''),
      setReviewMode,
    });

    await expect(callbacks.onApprovalNeeded('artifact', review, [])).resolves.toEqual({
      approved: true,
    });

    expect(setReviewMode).toHaveBeenCalledWith('');
    expect(reviewStore.get().source).toBeNull();
  });
});

describe('buildPromptCallbacks onContinuationNeeded', () => {
  beforeEach(() => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
    stopStore.__testReset();
    tasksStore.__testReset({
      tasks: [{ id: 'T002', title: 'slice', status: 'in_progress' }],
      currentTask: 1,
      totalTasks: 1,
    });
  });

  afterEach(() => {
    stopStore.__testReset();
    tasksStore.__testReset();
  });

  it('returns an empty answer without asking when the workflow is already unwinding', async () => {
    const controller = new AbortController();
    controller.abort();
    const setQuestionMode = vi.fn<UseInputModeResult['setQuestionMode']>();
    const callbacks = buildPromptCallbacks({
      inputMode: { ...makeInputMode(''), setQuestionMode },
      abortedRef: { current: false },
      controller,
    });

    const result = await callbacks.onContinuationNeeded?.('partial output', 'mid-step');

    expect(result).toBe('');
    expect(setQuestionMode).not.toHaveBeenCalled();
    expect(stopStore.get().phase).toBe('idle');
  });

  it('parks the brief instead of asking a question', async () => {
    const setQuestionMode = vi.fn<UseInputModeResult['setQuestionMode']>();
    const callbacks = makeCallbacksWithInputMode({ ...makeInputMode(''), setQuestionMode });

    const pending = callbacks.onContinuationNeeded?.('partial output', 'mid-step');
    await Promise.resolve();

    expect(setQuestionMode).not.toHaveBeenCalled();
    expect(lifecycleStore.get().status).toBe('paused');
    expect(stopStore.get()).toMatchObject({
      phase: 'parked',
      parked: { kind: 'mid-brief', taskId: 'T002' },
    });

    stopStore.resume('focus on retries');

    await expect(pending).resolves.toBe('focus on retries');
  });

  it('resumes with an empty steer when /resume settles the park', async () => {
    const callbacks = makeCallbacksWithInputMode(makeInputMode(''));

    const pending = callbacks.onContinuationNeeded?.('partial output', 'mid-step');
    await Promise.resolve();
    stopStore.resume('');

    await expect(pending).resolves.toBe('');
  });

  it('parks a boundary pause on the brief it stopped after', async () => {
    tasksStore.__testReset({
      tasks: [
        { id: 'T001', title: 'first', status: 'done' },
        { id: 'T002', title: 'second', status: 'pending' },
      ],
      totalTasks: 2,
    });
    const callbacks = makeCallbacksWithInputMode(makeInputMode(''));

    const pending = callbacks.onContinuationNeeded?.('', 'boundary');
    await Promise.resolve();

    expect(stopStore.get()).toMatchObject({
      phase: 'parked',
      parked: { kind: 'boundary', taskId: 'T001' },
    });

    stopStore.resume('');
    await expect(pending).resolves.toBe('');
  });
});

describe('buildPromptCallbacks onPlannerReply', () => {
  const reply = {
    call: 'research' as const,
    text: 'Which module?',
    questions: [],
    answers: [],
    answered: false,
  };

  it.each([
    { questions: [] },
    { questions: [{ id: 'ask-user', type: 'input' as const, text: 'Which module?' }] },
  ])('names the reviewer that asked, with questions $questions', async ({ questions }) => {
    const hints: string[] = [];
    const callbacks = makeCallbacksWithInputMode({
      ...makeInputMode('the cache'),
      setQuestionMode: async (hint) => {
        hints.push(hint);
        return 'the cache';
      },
    });

    await expect(callbacks.onPlannerReply?.({ ...reply, seat: 'review', questions })).resolves.toBe(
      'the cache',
    );
    expect(hints).toEqual(['Reply to the reviewer…']);
  });

  it('keeps the planner hint for conversations without a recorded seat', async () => {
    const hints: string[] = [];
    const callbacks = makeCallbacksWithInputMode({
      ...makeInputMode('the cache'),
      setQuestionMode: async (hint) => {
        hints.push(hint);
        return 'the cache';
      },
    });
    await callbacks.onPlannerReply?.(reply);
    expect(hints).toEqual(['Reply to the planner…']);
  });

  it('hands an empty submit on as an empty reply, not as no reply', async () => {
    await expect(makeCallbacks('   ').onPlannerReply?.(reply)).resolves.toBe('');
  });

  it('returns no reply when the workflow is already unwinding', async () => {
    const controller = new AbortController();
    controller.abort();
    const callbacks = buildPromptCallbacks({
      inputMode: makeInputMode(''),
      abortedRef: { current: false },
      controller,
    });

    await expect(callbacks.onPlannerReply?.(reply)).resolves.toBeUndefined();
  });
});

describe('buildPromptCallbacks onReviewChecksApproval', () => {
  const request = {
    scope: 'final' as const,
    commands: [{ id: 'V1', command: 'npm test', reason: 'covers the change' }],
  };

  afterEach(() => {
    reviewChecksPromptStore.reset();
  });

  it('opens the reviewer checks card and answers with the choice made on it', async () => {
    const answer = makeCallbacks('').onReviewChecksApproval?.(request);

    expect(reviewChecksPromptStore.get()).toMatchObject({ status: 'pending', request });
    closeReviewChecksPrompt('skip');
    await expect(answer).resolves.toBe('skip');
    expect(reviewChecksPromptStore.get().status).toBe('idle');
  });

  it('answers nothing once the run is stopped, and opens no card', async () => {
    const controller = new AbortController();
    controller.abort();
    const callbacks = buildPromptCallbacks({
      inputMode: makeInputMode(''),
      abortedRef: { current: false },
      controller,
    });

    await expect(callbacks.onReviewChecksApproval?.(request)).resolves.toBeUndefined();
    expect(reviewChecksPromptStore.get().status).toBe('idle');
  });
});
