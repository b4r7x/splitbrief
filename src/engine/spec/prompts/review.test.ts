import { describe, expect, it } from 'vitest';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import type { TriageInput } from '../../../core/schemas/review/verdict.js';
import { buildFinalReviewPrompt } from './review/final.js';
import { reviewInputsSection, triageLines } from './review/changes.js';
import { planBody } from './review/plan.js';
import type { ReviewPlanData } from './review/types.js';

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

describe('the ids a review answer names', () => {
  const redGateInput: TriageInput = {
    id: 'V4.1',
    kind: 'defect',
    source: 'check',
    text: 'Reviewer check V4 (npm test) failed with new failures.',
    file: null,
    checkIds: ['V4'],
  };
  const userInput: TriageInput = {
    id: 'U1',
    kind: 'defect',
    source: 'user',
    text: 'Keep the greeting lowercase.',
    file: null,
  };

  function requiredResults(prompt: string): string {
    return prompt.split('\n## Required Results\n')[1]?.split('\n## ')[0] ?? '';
  }

  it.each(['task', 'final'] as const)(
    'lists the check ids in the Required Results of a %s review and says a pending input id is not one',
    (reviewKind) => {
      const required = requiredResults(
        buildFinalReviewPrompt({
          spec: 'spec',
          taskBriefs: 'briefs',
          reviewKind,
          plan: reviewPlan([]),
          checkIds: ['K1', 'V4'],
          fixCycle: 1,
          pendingInputs: [redGateInput],
        }),
      );

      expect(required).toMatch(/^Task ids: T001$/m);
      expect(required).toMatch(/^Criterion ids: C1$/m);
      expect(required).toMatch(/^Check ids: K1, V4$/m);
      expect(required).toMatch(/checkIds name only ids from Check ids/);
      expect(required).toMatch(/V4\.1,? is not a check id/);
      expect(required).toMatch(/a finding for input V4\.1 names its check V4\b/);
    },
  );

  it('names the taskId and the criterionId that the finding of a task not met or a failed criterion carries', () => {
    const required = requiredResults(
      buildFinalReviewPrompt({ spec: 'spec', taskBriefs: 'briefs', plan: reviewPlan([]) }),
    );

    expect(required).toContain(
      "Every task not met needs a blocking finding whose taskId is that task's id, and every failed criterion needs a blocking finding whose criterionId is that criterion's id.",
    );
  });

  it('names the list of every id field and where the words of a fix go in a fix cycle review', () => {
    const required = requiredResults(
      buildFinalReviewPrompt({
        spec: 'spec',
        taskBriefs: 'briefs',
        plan: reviewPlan([]),
        checkIds: ['K1', 'V4'],
        fixCycle: 1,
        pendingInputs: [redGateInput],
      }),
    );

    expect(required).toContain("A fix task's criteria name only ids from Criterion ids");
    expect(required).toContain(
      'findingIds name only the blocking finding ids of this answer and the Pending Inputs ids',
    );
    expect(required).toContain("Write the words of a fix in the finding's acceptance");
    expect(required).toContain('taskId names only ids from Task ids');
    expect(required).toContain('criterionId names only ids from Criterion ids');
    expect(required).toContain('a rejected findingId names only Pending Inputs ids');
  });

  it('names the acceptance field of a finding, not of a fix task, in a fix cycle review', () => {
    const required = requiredResults(
      buildFinalReviewPrompt({
        spec: 'spec',
        taskBriefs: 'briefs',
        plan: reviewPlan([]),
        checkIds: ['K1', 'V4'],
        fixCycle: 1,
        pendingInputs: [redGateInput],
      }),
    );

    expect(required).toContain('The acceptance of each finding a fix task fixes names only');
    expect(required).not.toContain("A fix task's acceptance names only");
  });

  it('names the list of each finding id field and no fix task field in a review with no fix cycle', () => {
    const required = requiredResults(
      buildFinalReviewPrompt({
        spec: 'spec',
        taskBriefs: 'briefs',
        plan: reviewPlan([]),
        checkIds: ['K1'],
      }),
    );

    expect(required).toContain('taskId names only ids from Task ids');
    expect(required).toContain('criterionId names only ids from Criterion ids');
    expect(required).not.toContain("A fix task's criteria");
  });

  it('shows the check ids of a pending input from a red check, and keeps the line of an input with none', () => {
    const section = reviewInputsSection([redGateInput, userInput]);
    const [, red = '', user = ''] = section.split(/^- /m);

    expect(red).toMatch(/^\*\*V4\.1\*\* /);
    expect(red).toContain('checks: V4');
    expect(user).toBe('**U1** (user · defect) — Keep the greeting lowercase.');
  });
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
