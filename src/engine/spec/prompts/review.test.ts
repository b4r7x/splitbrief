import { describe, expect, it } from 'vitest';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { buildFinalReviewPrompt, planBody, triageLines, type ReviewPlanData } from './review.js';

const TEST_STRENGTH_ITEM =
  '7. **Test Strength**: For each test a task adds, check that the test fails when the behaviour the task names breaks. A test that still passes with that behaviour broken is a finding.';

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

describe('buildFinalReviewPrompt', () => {
  it.each([
    ['a review', undefined],
    ['a fix cycle review', 1],
  ])('forbids every git write in %s, as the BUILD prompt does', (_, fixCycle) => {
    expect(buildFinalReviewPrompt({ spec: 'spec', taskBriefs: 'briefs', fixCycle })).toContain(
      'Use git only to read (status, diff, log, show); never commit, branch, tag, checkout, switch, stash, reset, restore, rebase, merge, add, or change git config or hooks',
    );
  });

  it.each([
    ['task', '1. **Acceptance Criteria**: Check each due criterion and each reviewed task brief.'],
    ['final', '1. **Acceptance Criteria**: Check each criterion from the spec and task briefs.'],
  ] as const)(
    'asks the %s review if each test a task adds fails when the named behaviour breaks',
    (reviewKind, firstItem) => {
      const prompt = buildFinalReviewPrompt({ spec: 'spec', taskBriefs: 'briefs', reviewKind });
      const checklist = prompt.split('\n## Review Checklist\n')[1]?.split('\n## ')[0] ?? '';
      expect(checklist).toContain(firstItem);
      expect(checklist).toContain(TEST_STRENGTH_ITEM);
    },
  );
});

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
            ask: null,
          },
        },
      ]),
    ).toBe('- cycle 1: fix tasks: Guard the empty name (F1, P2)');
  });
});
