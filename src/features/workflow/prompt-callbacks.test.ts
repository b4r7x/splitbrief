import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_REVIEW_HINT, buildPromptCallbacks } from './prompt-callbacks.js';
import { REVIEW_HINT } from './review-commands.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import {
  TASK_REVIEW_COMMANDS,
  type TaskReviewRequest,
  type UserEditConflict,
} from '../../engine/events/workflow-events.js';
import { taskId } from '../../core/schemas/task.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { markInterruptResumed } from '../../stores/workflow/actions/resume.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

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
    onComplete: () => {},
  });
}

const conflict: UserEditConflict = {
  kind: 'current-task-conflict',
  files: ['src/a.ts'],
  affectedTaskIds: [taskId('T001')],
  currentTaskId: taskId('T001'),
  fileConflicts: [],
  safeToContinue: false,
  availableActions: ['continue-unrelated', 'pause', 'abort-workflow'],
};

function makeReviewRequest(): TaskReviewRequest {
  return {
    taskId: taskId('T001'),
    taskTitle: 'do the thing',
    status: 'done',
    filesTouched: ['src/a.ts'],
    validation: { passed: true, summary: 'all green', stages: [] },
    evidence: { summary: 'evidence', expected: [], observed: [] },
    cost: {
      tokenUsage: makeUsage({ implementerInput: 10, implementerOutput: 5 }),
    },
    availableCommands: [...TASK_REVIEW_COMMANDS],
  };
}

describe('buildPromptCallbacks onApprovalNeeded', () => {
  afterEach(() => {
    reviewStore.reset();
  });

  it.each(['briefs', 'spec', 'plan'] as const)(
    'uses the generic review hint for %s approvals',
    async (type) => {
      const setReviewMode = vi
        .fn<UseInputModeResult['setReviewMode']>()
        .mockResolvedValue({ approved: false });
      const callbacks = makeCallbacksWithInputMode({
        ...makeInputMode(''),
        setReviewMode,
      });

      await callbacks.onApprovalNeeded(type, '/tmp/review.md');

      expect(setReviewMode).toHaveBeenCalledWith(REVIEW_HINT);
    },
  );

  it('uses the frozen artifact text without retaining its display label as a path', async () => {
    const review = Object.freeze({
      label: 'Custom planner artifact',
      text: 'finalized artifact text',
    });
    const setReviewMode = vi
      .fn<UseInputModeResult['setReviewMode']>()
      .mockImplementation(async (hint) => {
        expect(hint).toBe(ARTIFACT_REVIEW_HINT);
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

    await expect(callbacks.onApprovalNeeded('artifact', review)).resolves.toEqual({
      approved: true,
    });

    expect(setReviewMode).toHaveBeenCalledWith(ARTIFACT_REVIEW_HINT);
    expect(reviewStore.get().source).toBeNull();
  });
});

describe('buildPromptCallbacks onUserEditConflict', () => {
  it('maps the "continue" answer to the continue-unrelated action', async () => {
    const result = await makeCallbacks('continue').onUserEditConflict?.(conflict);
    expect(result).toBe('continue-unrelated');
  });

  it('maps a whitespace-only answer to pause', async () => {
    const result = await makeCallbacks('   ').onUserEditConflict?.(conflict);
    expect(result).toBe('pause');
  });

  it('falls back to pause for an unrecognised answer', async () => {
    const result = await makeCallbacks('???').onUserEditConflict?.(conflict);
    expect(result).toBe('pause');
  });

  it('maps the "abort" answer to abort-workflow', async () => {
    const result = await makeCallbacks('abort').onUserEditConflict?.(conflict);
    expect(result).toBe('abort-workflow');
  });
});

describe('buildPromptCallbacks onTaskReviewNeeded', () => {
  beforeEach(() => {
    feedbackStore.reset();
    lifecycleStore.__testReset();
  });

  it('parses a notes answer as continue with notes attached', async () => {
    const result = await makeCallbacks('notes looks good to me').onTaskReviewNeeded?.(
      makeReviewRequest(),
    );
    expect(result).toEqual({ action: 'continue', notes: 'looks good to me' });
  });

  it('re-prompts on unrecognized input instead of accepting the task', async () => {
    const result = await makeCallbacks(['redo it please', 'continue']).onTaskReviewNeeded?.(
      makeReviewRequest(),
    );

    expect(result).toEqual({ action: 'continue' });
    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('Unrecognized task review command');
  });

  it('re-prompts when the answer was not advertised by availableCommands', async () => {
    const result = await makeCallbacks(['abort', 'continue']).onTaskReviewNeeded?.({
      ...makeReviewRequest(),
      availableCommands: ['continue'],
    });

    expect(result).toEqual({ action: 'continue' });
    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('Use: continue');
  });

  it('returns task review abort without mutating workflow state', async () => {
    const result = await makeCallbacks('abort').onTaskReviewNeeded?.(makeReviewRequest());

    expect(result).toEqual({ action: 'abort' });
    expect(lifecycleStore.get().cancelled).toBe(false);
  });
});

describe('buildPromptCallbacks onContinuationNeeded', () => {
  beforeEach(() => {
    lifecycleStore.__testReset({ phase: 'implementing', status: 'running' });
  });

  it('returns an empty answer without asking when the workflow is already unwinding', async () => {
    const controller = new AbortController();
    controller.abort();
    const setQuestionMode = vi.fn<UseInputModeResult['setQuestionMode']>();
    const callbacks = buildPromptCallbacks({
      inputMode: { ...makeInputMode(''), setQuestionMode },
      abortedRef: { current: false },
      controller,
      onComplete: () => {},
    });

    const result = await callbacks.onContinuationNeeded?.('partial output');

    expect(result).toBe('');
    expect(setQuestionMode).not.toHaveBeenCalled();
  });

  it('onContinuationNeeded marks the workflow interrupted and re-asks after a superseded empty resolution', async () => {
    const statuses: string[] = [];
    const setQuestionMode = vi
      .fn<UseInputModeResult['setQuestionMode']>()
      .mockImplementationOnce(async () => {
        statuses.push(lifecycleStore.get().status);
        return '';
      })
      .mockImplementationOnce(async () => {
        statuses.push(lifecycleStore.get().status);
        markInterruptResumed();
        return 'focus on retries';
      });
    const callbacks = makeCallbacksWithInputMode({ ...makeInputMode(''), setQuestionMode });

    const result = await callbacks.onContinuationNeeded?.('partial output');

    expect(result).toBe('focus on retries');
    expect(setQuestionMode).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual(['interrupted', 'interrupted']);
  });

  it('onContinuationNeeded returns the submission once the interrupt is cleared', async () => {
    const setQuestionMode = vi.fn<UseInputModeResult['setQuestionMode']>(async () => {
      markInterruptResumed();
      return '';
    });
    const callbacks = makeCallbacksWithInputMode({ ...makeInputMode(''), setQuestionMode });

    const result = await callbacks.onContinuationNeeded?.('partial output');

    expect(result).toBe('');
    expect(setQuestionMode).toHaveBeenCalledTimes(1);
    expect(lifecycleStore.get().status).toBe('running');
  });
});
