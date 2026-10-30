import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { reviewPlanData } from './review-plan.js';

describe('reviewPlanData', () => {
  it('tells the reviewer a skipped brief from one that is still to build', () => {
    const state = makeImplState([
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'skipped' }),
      makeTask({ id: 'T003', status: 'pending' }),
    ]);

    expect(reviewPlanData(state).tasks.map((task) => [task.id, task.status])).toEqual([
      ['T001', 'done'],
      ['T002', 'skipped'],
      ['T003', 'pending'],
    ]);
  });
});
