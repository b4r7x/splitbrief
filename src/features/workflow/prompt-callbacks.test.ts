import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildPromptCallbacks } from './prompt-callbacks.js';
import { BRIEFS_REVIEW_HINT, REVIEW_HINT } from './review-parser.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import {
  TASK_REVIEW_COMMANDS,
  type TaskReviewRequest,
  type UserEditConflict,
} from '../../engine/events/workflow-events.js';
import { taskId } from '../../core/schemas/task.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';

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
  return buildPromptCallbacks()({
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
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 10,
        implementerOutput: 5,
        escalationInput: 0,
        escalationOutput: 0,
      },
    },
    availableCommands: [...TASK_REVIEW_COMMANDS],
  };
}

describe('buildPromptCallbacks onApprovalNeeded', () => {
  it('uses the brief review hint for brief approvals', async () => {
    const setReviewMode = vi
      .fn<UseInputModeResult['setReviewMode']>()
      .mockResolvedValue({ approved: false });
    const callbacks = makeCallbacksWithInputMode({
      ...makeInputMode(''),
      setReviewMode,
    });

    await callbacks.onApprovalNeeded('briefs', '/tmp/tasks.md');

    expect(setReviewMode).toHaveBeenCalledWith(BRIEFS_REVIEW_HINT);
  });

  it.each([
    'spec',
    'plan',
  ] as const)('uses the generic review hint for %s approvals', async (type) => {
    const setReviewMode = vi
      .fn<UseInputModeResult['setReviewMode']>()
      .mockResolvedValue({ approved: false });
    const callbacks = makeCallbacksWithInputMode({
      ...makeInputMode(''),
      setReviewMode,
    });

    await callbacks.onApprovalNeeded(type, '/tmp/review.md');

    expect(setReviewMode).toHaveBeenCalledWith(REVIEW_HINT);
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

  it('parses an empty answer as continue', async () => {
    const result = await makeCallbacks('').onTaskReviewNeeded?.(makeReviewRequest());
    expect(result).toEqual({ action: 'continue' });
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
  it('returns an empty answer so the continuation loop can use its default retry text', async () => {
    const result = await makeCallbacks('').onContinuationNeeded?.('partial output');
    expect(result).toBe('');
  });
});
