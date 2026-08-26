import { describe, it, expect } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import { taskId } from '../../core/schemas/task.js';
import { buildDetachedRetryState } from './retry-state.js';

describe('buildDetachedRetryState', () => {
  it('re-runs only failed work: resets failed tasks and points at the first incomplete task', () => {
    const state = makeImplState(
      [
        makeTask({ id: 'T001', status: 'done' }),
        makeTask({ id: 'T002', status: 'failed', file: 'src/two.ts' }),
        makeTask({ id: 'T003', status: 'pending', file: 'src/three.ts' }),
      ],
      { currentTaskIndex: 1, attempt: 3, phase: 'final-review' },
    );

    const retry = buildDetachedRetryState(state);

    expect(retry.tasks.map((task) => task.status)).toEqual(['done', 'pending', 'pending']);
    expect(retry.currentTaskIndex).toBe(1);
    expect(retry.phase).toBe('implementing');
    expect(retry.attempt).toBe(0);
    expect(retry.pendingRecovery).toBeUndefined();
  });

  it('preserves completed tasks and their persisted per-task cost attribution', () => {
    const taskBreakdowns: TaskTokenUsage[] = [
      {
        taskId: taskId('T001'),
        taskTitle: 'done task',
        method: 'local',
        implementerTokens: 500,
        escalationTokens: 0,
        retryCount: 0,
        tool: 'deepseek',
        model: 'deepseek-chat',
      },
    ];
    const state = makeImplState(
      [
        makeTask({ id: 'T001', status: 'done' }),
        makeTask({ id: 'T002', status: 'failed', file: 'src/two.ts' }),
      ],
      { currentTaskIndex: 1, taskBreakdowns },
    );

    const retry = buildDetachedRetryState(state);

    // done/escalated/skipped tasks and their taskBreakdowns survive — the retry does not
    // re-plan or re-implement completed work, so saveFinalSession stays cost-honest.
    expect(retry.tasks[0]?.status).toBe('done');
    expect(retry.taskBreakdowns).toEqual(taskBreakdowns);
    expect(retry.tokenUsage).toEqual(state.tokenUsage);
  });

  it('rewinds currentTaskIndex back to the earliest failed task', () => {
    const state = makeImplState(
      [
        makeTask({ id: 'T001', status: 'done' }),
        makeTask({ id: 'T002', status: 'failed', file: 'src/two.ts' }),
        makeTask({ id: 'T003', status: 'failed', file: 'src/three.ts' }),
      ],
      { currentTaskIndex: 2 },
    );

    const retry = buildDetachedRetryState(state);

    expect(retry.currentTaskIndex).toBe(1);
    expect(retry.tasks.map((task) => task.status)).toEqual(['done', 'pending', 'pending']);
  });
});
