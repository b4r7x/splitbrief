import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addEvent, resetWorkflow } from '../../stores/workflow/actions.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { planEditorStore } from '../../stores/workflow/plan-editor.js';
import { setQueueHandler, clearAllHandlers } from './handlers.js';
import { createReviewInputHandler, parseReviewCommand } from './review-parser.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import type { Phase } from '../../core/schemas/enums.js';

function makeInputMode(mode: 'normal' | 'review' | 'question', resolve = vi.fn()): UseInputModeResult {
  if (mode === 'review') return { mode, resolve } as unknown as UseInputModeResult;
  if (mode === 'question') return { mode, resolve } as unknown as UseInputModeResult;
  return { mode: 'normal' } as unknown as UseInputModeResult;
}

function setPhase(phase: Phase) {
  addEvent({ type: 'planner_status', ts: Date.now(), phase, status: 'running' });
}

beforeEach(() => {
  resetWorkflow();
  feedbackStore.reset();
  clearAllHandlers();
  vi.clearAllMocks();
  lifecycleStore.__testReset();
  reviewStore.clearReview();
  planEditorStore.__testReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createReviewInputHandler – implementer-phase guard (Bug #5)', () => {
  it('sets error feedback when submitting during implementing phase', async () => {
    setPhase('implementing');
    const enqueue = vi.fn();
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('some text');

    const { message, isError } = feedbackStore.get();
    expect(isError).toBe(true);
    expect(message).toContain('Input disabled during task implementation');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sets error feedback when submitting during validating-task phase', async () => {
    setPhase('validating-task');
    const enqueue = vi.fn();
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('some text');

    const { isError } = feedbackStore.get();
    expect(isError).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sets error feedback when submitting during escalating phase', async () => {
    setPhase('escalating');
    const enqueue = vi.fn();
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('some text');

    expect(feedbackStore.get().isError).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('createReviewInputHandler – enqueue during live planner phase (Bug #4)', () => {
  it('queues user input while the planner is researching', async () => {
    setPhase('researching');
    const enqueue = vi.fn();
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('add error handling');

    expect(enqueue).toHaveBeenCalledWith('add error handling', 'researching');
  });

  it('queues user input while the planner is specifying', async () => {
    setPhase('specifying');
    const enqueue = vi.fn();
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('make it simpler');

    expect(enqueue).toHaveBeenCalledWith('make it simpler', 'specifying');
  });

  it('sets error when no queue handler is set', async () => {
    setPhase('researching');
    // no setQueueHandler — returns false

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('no handler');

    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('no active workflow');
  });
});

describe('createReviewInputHandler – idle / other phases', () => {
  it('does nothing when phase is idle and mode is normal', async () => {
    // phase stays as 'idle' (initial state)
    const enqueue = vi.fn();
    setQueueHandler(enqueue);

    const { handleInput } = createReviewInputHandler(makeInputMode('normal'));
    await handleInput('ignored');

    expect(enqueue).not.toHaveBeenCalled();
    // feedbackStore should not be set with error
    expect(feedbackStore.get().isError).toBe(false);
  });
});

describe('parseReviewCommand', () => {
  it('parses approve', () => {
    expect(parseReviewCommand('approve')).toEqual({ action: 'approve' });
    expect(parseReviewCommand('yes')).toEqual({ action: 'approve' });
  });

  it('parses reject/quit aliases', () => {
    expect(parseReviewCommand('reject')).toEqual({ action: 'quit' });
    expect(parseReviewCommand('quit')).toEqual({ action: 'quit' });
  });

  it('parses comment with text', () => {
    expect(parseReviewCommand('comment add more tests')).toEqual({ action: 'approve', comment: 'add more tests' });
  });

  it('parses edit', () => {
    expect(parseReviewCommand('edit')).toEqual({ action: 'edit' });
    expect(parseReviewCommand('e')).toEqual({ action: 'edit' });
  });

  it('returns null for unknown input', () => {
    expect(parseReviewCommand('unknown command here')).toBeNull();
  });
});

describe('createReviewInputHandler – brief review edit mode', () => {
  it.each(['e', 'edit'])('opens persisted tasks.md and resolves edit for %s during brief review', async (command) => {
    lifecycleStore.__testReset({ phase: 'reviewing-briefs' });
    reviewStore.setReviewFile('/tmp/tasks.md');
    vi.stubEnv('EDITOR', 'true');
    const resolve = vi.fn();
    const { handleInput } = createReviewInputHandler(makeInputMode('review', resolve));

    await handleInput(command);

    expect(planEditorStore.get().runtimeRichMode).toBe(false);
    expect(resolve).toHaveBeenCalledWith({ approved: false, action: 'edit' });
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('keeps external editor behavior for non-brief reviews', async () => {
    lifecycleStore.__testReset({ phase: 'reviewing-plan' });
    reviewStore.setReviewFile('/tmp/supporting-spec.md');
    vi.stubEnv('EDITOR', '/definitely/missing-diptych-editor');
    const { handleInput } = createReviewInputHandler(makeInputMode('review'));

    await handleInput('edit');

    expect(planEditorStore.get().runtimeRichMode).toBe(false);
    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('Failed to open editor');
  });
});
