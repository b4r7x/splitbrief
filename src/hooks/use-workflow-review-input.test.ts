import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workflowStore } from '../stores/workflow.js';
import { feedbackStore } from '../stores/feedback.js';
import { useWorkflowReviewInput } from './use-workflow-review-input.js';
import type { UseInputModeResult } from './use-input-mode.js';
import type { Phase } from '../types.js';

function makeInputMode(mode: 'normal' | 'review' | 'question', resolve = vi.fn()): UseInputModeResult {
  if (mode === 'review') return { mode, resolve } as unknown as UseInputModeResult;
  if (mode === 'question') return { mode, resolve } as unknown as UseInputModeResult;
  return { mode: 'normal' } as unknown as UseInputModeResult;
}

function setPhase(phase: Phase) {
  workflowStore.addEvent({ type: 'planner-status', ts: Date.now(), phase, status: 'running' });
}

beforeEach(() => {
  workflowStore.reset();
  feedbackStore.reset();
  vi.clearAllMocks();
});

describe('useWorkflowReviewInput – implementer-phase guard (Bug #5)', () => {
  it('sets error feedback when submitting during implementing phase', async () => {
    setPhase('implementing');
    const enqueue = vi.fn();
    workflowStore.setQueueHandler(enqueue);

    const { handleInput } = useWorkflowReviewInput({ inputMode: makeInputMode('normal') });
    await handleInput('some text');

    const { message, isError } = feedbackStore.get();
    expect(isError).toBe(true);
    expect(message).toContain('Input disabled during task implementation');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sets error feedback when submitting during validating-task phase', async () => {
    setPhase('validating-task');
    const enqueue = vi.fn();
    workflowStore.setQueueHandler(enqueue);

    const { handleInput } = useWorkflowReviewInput({ inputMode: makeInputMode('normal') });
    await handleInput('some text');

    const { isError } = feedbackStore.get();
    expect(isError).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sets error feedback when submitting during escalating phase', async () => {
    setPhase('escalating');
    const enqueue = vi.fn();
    workflowStore.setQueueHandler(enqueue);

    const { handleInput } = useWorkflowReviewInput({ inputMode: makeInputMode('normal') });
    await handleInput('some text');

    expect(feedbackStore.get().isError).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('useWorkflowReviewInput – enqueue during live planner phase (Bug #4)', () => {
  it('calls requestEnqueue during researching phase', async () => {
    setPhase('researching');
    const enqueue = vi.fn();
    workflowStore.setQueueHandler(enqueue);

    const { handleInput } = useWorkflowReviewInput({ inputMode: makeInputMode('normal') });
    await handleInput('add error handling');

    expect(enqueue).toHaveBeenCalledWith('add error handling', 'researching');
  });

  it('calls requestEnqueue during specifying phase', async () => {
    setPhase('specifying');
    const enqueue = vi.fn();
    workflowStore.setQueueHandler(enqueue);

    const { handleInput } = useWorkflowReviewInput({ inputMode: makeInputMode('normal') });
    await handleInput('make it simpler');

    expect(enqueue).toHaveBeenCalledWith('make it simpler', 'specifying');
  });

  it('sets error when no queue handler is set', async () => {
    setPhase('researching');
    // no setQueueHandler — returns false

    const { handleInput } = useWorkflowReviewInput({ inputMode: makeInputMode('normal') });
    await handleInput('no handler');

    expect(feedbackStore.get().isError).toBe(true);
    expect(feedbackStore.get().message).toContain('no active workflow');
  });
});

describe('useWorkflowReviewInput – idle / other phases', () => {
  it('does nothing when phase is idle and mode is normal', async () => {
    // phase stays as 'idle' (initial state)
    const enqueue = vi.fn();
    workflowStore.setQueueHandler(enqueue);

    const { handleInput } = useWorkflowReviewInput({ inputMode: makeInputMode('normal') });
    await handleInput('ignored');

    expect(enqueue).not.toHaveBeenCalled();
    // feedbackStore should not be set with error
    expect(feedbackStore.get().isError).toBe(false);
  });
});
