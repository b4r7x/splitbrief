import { describe, expect, it } from 'vitest';
import { parsePlannerEstimateReview } from './parser.js';

describe('parsePlannerEstimateReview', () => {
  it.each([
    'ok',
    'split-suggested',
    'risk',
    'needs-user-decision',
  ] as const)('parses %s classifications', (classification) => {
    const parsed = parsePlannerEstimateReview(
      JSON.stringify({
        classification,
        affectedTaskIds: ['T002'],
        reason: 'Task is near the selected context window.',
        recommendedUserDecision: 'Split T002 before spending on implementation.',
      }),
    );

    expect(parsed).toEqual({
      classification,
      affectedTaskIds: ['T002'],
      reason: 'Task is near the selected context window.',
      recommendedUserDecision: 'Split T002 before spending on implementation.',
    });
  });

  it('returns null for an unknown classification', () => {
    expect(
      parsePlannerEstimateReview('{"classification":"reroute","affectedTaskIds":[]}'),
    ).toBeNull();
  });

  it('allows ok with an empty affected task list when reason and decision are present', () => {
    const parsed = parsePlannerEstimateReview(
      JSON.stringify({
        classification: 'ok',
        affectedTaskIds: [],
        reason: 'The deterministic estimate is enough for the current task set.',
        recommendedUserDecision: 'Continue with the deterministic estimate.',
      }),
    );

    expect(parsed).toEqual({
      classification: 'ok',
      affectedTaskIds: [],
      reason: 'The deterministic estimate is enough for the current task set.',
      recommendedUserDecision: 'Continue with the deterministic estimate.',
    });
  });

  it.each([
    {
      label: 'missing reason',
      body: {
        classification: 'risk',
        affectedTaskIds: ['T002'],
        recommendedUserDecision: 'Split T002.',
      },
    },
    {
      label: 'blank reason',
      body: {
        classification: 'risk',
        affectedTaskIds: ['T002'],
        reason: ' ',
        recommendedUserDecision: 'Split T002.',
      },
    },
    {
      label: 'missing recommendation',
      body: { classification: 'risk', affectedTaskIds: ['T002'], reason: 'Task is risky.' },
    },
    {
      label: 'blank recommendation',
      body: {
        classification: 'risk',
        affectedTaskIds: ['T002'],
        reason: 'Task is risky.',
        recommendedUserDecision: ' ',
      },
    },
  ])('returns null for $label', ({ body }) => {
    expect(parsePlannerEstimateReview(JSON.stringify(body))).toBeNull();
  });

  it.each([
    'split-suggested',
    'risk',
    'needs-user-decision',
  ] as const)('returns null when %s has no affected task ids', (classification) => {
    expect(
      parsePlannerEstimateReview(
        JSON.stringify({
          classification,
          affectedTaskIds: [],
          reason: 'The planner found a task-level issue.',
          recommendedUserDecision: 'Review the affected task before spending.',
        }),
      ),
    ).toBeNull();
  });
});
