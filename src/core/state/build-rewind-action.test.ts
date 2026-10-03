import { describe, expect, it } from 'vitest';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { buildRewindAction } from './build-rewind-action.js';

describe('buildRewindAction', () => {
  it('returns a task_reset event carrying the current phase and taskId', () => {
    const state = makeImplState([makeTask()]);

    const outcome = buildRewindAction({ request: { target: 'task', taskId: 'T001' }, state });

    expect(outcome.action).toEqual({ type: 'RESET_TASK', taskId: 'T001' });
    expect(outcome.event).toMatchObject({
      type: 'task_reset',
      phase: state.phase,
      taskId: 'T001',
    });
  });
});
