import { describe, it, expect, beforeEach } from 'vitest';
import { buildPromptCallbacks } from './prompt-callbacks.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import type { TaskReviewRequest, UserEditConflict } from '../../engine/events/workflow-events.js';
import { taskId } from '../../core/schemas/task.js';
import { feedbackStore } from '../../stores/ui/feedback.js';

function makeInputMode(answers: string | string[]): UseInputModeResult {
  const queue = Array.isArray(answers) ? [...answers] : [answers];
  return {
    mode: 'normal',
    hint: '',
    setReviewMode: async () => ({ approved: false }),
    setQuestionMode: async () => queue.shift() ?? '',
    resolve: () => {},
    resetMode: () => {},
  };
}

function makeCallbacks(answers: string | string[]) {
  return buildPromptCallbacks()({
    inputMode: makeInputMode(answers),
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
    availableCommands: ['continue', 'redo-task', 'revise-plan', 'abort'],
  };
}

describe('buildPromptCallbacks onUserEditConflict', () => {
  it('maps the "continue" answer to the continue-unrelated action', async () => {
    const result = await makeCallbacks('continue').onUserEditConflict?.(conflict);
    expect(result).toBe('continue-unrelated');
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
});
