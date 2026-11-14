import type { ReviewPlanData } from '../../src/engine/spec/prompts/review/types.js';

export function reviewPlan(decisions: ReviewPlanData['decisions']): ReviewPlanData {
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
