import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';
import { runPreTaskHooksAndPublish } from './pre-task.js';

const capture = vi.hoisted(() => ({ snapshotFails: false }));
vi.mock('../approval/file-snapshots/capture.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../approval/file-snapshots/capture.js')>();
  return {
    ...actual,
    getChangedFilesSnapshot: async (...args: Parameters<typeof actual.getChangedFilesSnapshot>) => {
      if (capture.snapshotFails) throw new Error('git status exited 128');
      return actual.getChangedFilesSnapshot(...args);
    },
  };
});

afterEach(() => {
  capture.snapshotFails = false;
  cleanupTaskProjects();
});

describe('runPreTaskHooksAndPublish', () => {
  it('raises a snapshot-failed recovery when the task baseline cannot be captured', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const { bus, events } = makeBusRecorder();
    const setTrackedState = vi.fn();
    capture.snapshotFails = true;

    const result = await runPreTaskHooksAndPublish({
      wctx: makeWorkflowContext({ bus }),
      task,
      state,
      index: 0,
      totalTasks: 1,
      setTrackedState,
    });

    expect(result.proceed).toBe(false);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'snapshot-failed',
      taskId: 'T001',
      recommendedAction: 'retry-same-worker',
    });
    expect(
      events.some(
        (e) => e.type === 'error' && e.message.startsWith('Failed to capture task baseline'),
      ),
    ).toBe(true);
  });
});
