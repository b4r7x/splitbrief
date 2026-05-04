import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reviewTaskIfNeeded, formatTaskReviewNotes } from './task-review.js';
import type { WorkflowContext } from '../types.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';

vi.mock('./review.js', () => ({
  buildTaskReviewRequest: vi.fn().mockReturnValue({
    taskId: 'T1',
    taskTitle: 'Test',
    status: 'done',
    validation: { passed: true },
  }),
  shouldReviewTask: vi.fn().mockReturnValue(true),
}));

vi.mock('../queue.js', () => ({
  enqueueUserMessage: vi.fn().mockReturnValue({ state: { messageQueue: [{ text: 'queued note' }] } }),
}));

vi.mock('../events.js', () => ({
  publishTaskReviewNeeded: vi.fn(),
}));

import { shouldReviewTask } from './review.js';
import { enqueueUserMessage } from '../queue.js';
import { publishTaskReviewNeeded } from '../events.js';

const mockShouldReviewTask = vi.mocked(shouldReviewTask);
const mockEnqueueUserMessage = vi.mocked(enqueueUserMessage);

describe('reviewTaskIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns continue when review mode is none without calling shouldReviewTask', async () => {
    const wctx = {
      config: { workflow: { taskReview: 'none' } },
      callbacks: {},
    } as unknown as WorkflowContext;

    const state = { phase: 'implementing', currentTaskIndex: 0, tasks: [] } as unknown as WorkflowState;

    const result = await reviewTaskIfNeeded({
      wctx,
      state,
      setTrackedState: vi.fn(),
      task: { id: 'T1', title: 'Test' } as Task,
      taskIndex: 0,
      filesTouched: [],
      taskBreakdowns: [] as TaskTokenUsage[],
    });

    expect(result.decision).toBe('continue');
    expect(mockShouldReviewTask).not.toHaveBeenCalled();
    expect(publishTaskReviewNeeded).not.toHaveBeenCalled();
  });

  it('returns continue when shouldReviewTask returns false', async () => {
    mockShouldReviewTask.mockReturnValue(false);

    const wctx = {
      config: { workflow: { taskReview: 'every' } },
      callbacks: {},
      bus: { publish: vi.fn() },
      projectDir: '/tmp',
      sessionId: 'test',
    } as unknown as WorkflowContext;

    const state = { phase: 'implementing', currentTaskIndex: 0, tasks: [] } as unknown as WorkflowState;

    const result = await reviewTaskIfNeeded({
      wctx,
      state,
      setTrackedState: vi.fn(),
      task: { id: 'T1', title: 'Test' } as Task,
      taskIndex: 0,
      filesTouched: [],
      taskBreakdowns: [] as TaskTokenUsage[],
    });

    expect(result.decision).toBe('continue');
    expect(mockShouldReviewTask).toHaveBeenCalled();
    expect(publishTaskReviewNeeded).not.toHaveBeenCalled();
  });

  it('returns stop when callback aborts', async () => {
    mockShouldReviewTask.mockReturnValue(true);

    const wctx = {
      config: { workflow: { taskReview: 'every' } },
      callbacks: { onTaskReviewNeeded: vi.fn().mockResolvedValue({ action: 'abort' }) },
      bus: { publish: vi.fn() },
      projectDir: '/tmp',
      sessionId: 'test',
    } as unknown as WorkflowContext;

    const state = { phase: 'implementing', currentTaskIndex: 0, tasks: [] } as unknown as WorkflowState;

    const result = await reviewTaskIfNeeded({
      wctx,
      state,
      setTrackedState: vi.fn(),
      task: { id: 'T1', title: 'Test' } as Task,
      taskIndex: 0,
      filesTouched: [],
      taskBreakdowns: [] as TaskTokenUsage[],
    });

    expect(result.decision).toBe('stop');
    expect(publishTaskReviewNeeded).toHaveBeenCalled();
  });

  it('queues notes and updates state when notes provided', async () => {
    mockShouldReviewTask.mockReturnValue(true);
    const setTrackedState = vi.fn();

    const wctx = {
      config: { workflow: { taskReview: 'every', persistTranscript: false } },
      callbacks: { onTaskReviewNeeded: vi.fn().mockResolvedValue({ action: 'continue', notes: 'fix this' }) },
      bus: { publish: vi.fn() },
      projectDir: '/tmp',
      sessionId: 'test',
    } as unknown as WorkflowContext;

    const state = { phase: 'implementing', currentTaskIndex: 0, tasks: [] } as unknown as WorkflowState;

    const result = await reviewTaskIfNeeded({
      wctx,
      state,
      setTrackedState,
      task: { id: 'T1', title: 'Test' } as Task,
      taskIndex: 0,
      filesTouched: [],
      taskBreakdowns: [] as TaskTokenUsage[],
    });

    expect(result.decision).toBe('continue');
    expect(mockEnqueueUserMessage).toHaveBeenCalled();
    expect(setTrackedState).toHaveBeenCalled();
  });
});

describe('formatTaskReviewNotes', () => {
  it('formats review notes with task info', () => {
    const request = { taskId: 'T1', taskTitle: 'Test Task' } as any;
    const result = formatTaskReviewNotes(request, 'some notes');
    expect(result).toBe('Task review note for T1 - Test Task:\nsome notes');
  });
});
