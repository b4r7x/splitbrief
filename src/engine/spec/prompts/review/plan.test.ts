import { describe, expect, it } from 'vitest';
import { reviewPlan } from '#testing/helpers/review-plan.js';
import { planBody } from './plan.js';

const DECLARED_NOTE =
  'The implementer of a task declared each decision that has a task id. Nobody confirmed these decisions: judge them against the criteria and the code.';

describe('planBody', () => {
  it('says a decision with a task id is an unconfirmed implementer decision, in a final and a task review', () => {
    const plan = reviewPlan([
      { text: 'Keep the greeting pure', taskId: null },
      { text: 'Kept the old name — callers import it', taskId: 'T001' },
    ]);
    for (const taskIds of [undefined, ['T001']]) {
      expect(planBody(plan, taskIds)).toContain(
        `### Decisions\n\n${DECLARED_NOTE}\n\n- Keep the greeting pure\n- Kept the old name — callers import it (T001)`,
      );
    }
  });

  it("adds no note when every decision is the plan's own", () => {
    const body = planBody(reviewPlan([{ text: 'Keep the greeting pure', taskId: null }]));
    expect(body).toContain('### Decisions\n\n- Keep the greeting pure');
    expect(body).not.toContain(DECLARED_NOTE);
  });
});
