import { describe, expect, it } from 'vitest';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { planBody, triageLines, type ReviewPlanData } from './review.js';

const DECLARED_NOTE =
  'The implementer of a task declared each decision that has a task id. Nobody confirmed these decisions: judge them against the criteria and the code.';

function reviewPlan(decisions: ReviewPlanData['decisions']): ReviewPlanData {
  return {
    criteria: [{ id: 'C1', text: 'The greeting is returned', checkIds: [] }],
    decisions,
    tasks: [
      {
        id: 'T001',
        lineageId: 'T001',
        status: 'done',
        title: 'Hello module',
        intent: 'Add the hello export',
        steps: [],
        criteria: ['C1'],
        suggestedFiles: ['src/hello.ts'],
        exclusions: [],
      },
    ],
  };
}

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

describe('triageLines', () => {
  it('names the findings each fix task of a cycle answered', () => {
    expect(
      triageLines([
        {
          cycle: 1,
          at: '2026-10-03T00:00:00Z',
          inputIds: [],
          result: {
            fixTasks: [
              {
                ...makeTaskSpec({ id: 'T900', title: 'Guard the empty name' }),
                findingIds: ['F1', 'P2'],
              },
            ],
            rejected: [],
            verify: [],
            ask: null,
          },
        },
      ]),
    ).toBe('- cycle 1: fix tasks: Guard the empty name (F1, P2)');
  });
});
