import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { TaskId } from '../../core/schemas/task.js';
import { buildPlannerEstimateReviewPrompt } from '../spec/prompts/estimate-review.js';
import { buildPlannerEstimateReviewPacket } from './planner-estimate-review.js';
import { parsePlannerEstimateReview } from './estimate-review-parser.js';

type DeterministicEstimate = NonNullable<CostPrediction['deterministic']>;

const estimate: DeterministicEstimate = {
  taskCount: 3,
  taskFitCounts: { fits: 1, tight: 1, overflow: 1, unknown: 0 },
  contextConfidenceCounts: {
    contextExplicit: 2,
    contextKnownCatalog: 0,
    contextCachedProvider: 0,
    contextConservativeFallback: 0,
    profileUnavailable: 1,
  },
  priceConfidenceCounts: {
    priceKnown: 1,
    priceUnknown: 1,
    profileUnavailable: 1,
  },
  totals: {
    knownActualEstimate: null,
    hypotheticalAllPlanner: 0.42,
    estimatedSavings: null,
    unknownCostReason: ['implementer-price-unknown', 'profile-unavailable'],
  },
  tasks: [
    {
      taskId: 'T001' as TaskId,
      title: 'Small config change',
      estimatedPromptTokens: 1200,
      selectedProfileId: 'cheap-worker',
      contextFit: 'fits',
      contextConfidence: 'context-explicit',
      priceConfidence: 'price-known',
      estimatedImplementerCost: 0.01,
      hypotheticalPlannerCost: 0.05,
    },
    {
      taskId: 'T002' as TaskId,
      title: 'Large parser rewrite',
      estimatedPromptTokens: 18_000,
      selectedProfileId: 'cheap-worker',
      contextFit: 'tight',
      contextConfidence: 'context-explicit',
      priceConfidence: 'price-unknown',
      estimatedImplementerCost: null,
      hypotheticalPlannerCost: 0.2,
    },
    {
      taskId: 'T003' as TaskId,
      title: 'Split huge migration',
      estimatedPromptTokens: 48_000,
      selectedProfileId: null,
      contextFit: 'overflow',
      contextConfidence: 'profile-unavailable',
      priceConfidence: 'profile-unavailable',
      estimatedImplementerCost: null,
      hypotheticalPlannerCost: 0.17,
    },
  ],
};

describe('planner estimate review packet', () => {
  it('is compact and task-focused for the planner prompt', () => {
    const hugeTaskBody = 'full source body '.repeat(500);
    const config = {
      ...makeConfig(),
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': {
            kind: 'api' as const,
            provider: 'deepseek',
            apiBase: 'https://api.deepseek.com/v1',
            model: 'deepseek-chat',
            contextLength: 20_000,
            costTier: 'cheap' as const,
          },
        },
      },
    };

    const packet = buildPlannerEstimateReviewPacket({
      estimate,
      config,
      mode: 'standard',
      forcedProfileId: 'cheap-worker',
    });
    const prompt = buildPlannerEstimateReviewPrompt(packet);

    expect(packet).toMatchObject({
      taskCount: 3,
      taskFitCounts: { fits: 1, tight: 1, overflow: 1, unknown: 0 },
      warnings: {
        unknownPriceTaskIds: ['T002', 'T003'],
        unknownContextTaskIds: ['T003'],
        tightTaskIds: ['T002'],
        overflowTaskIds: ['T003'],
      },
      userSelections: {
        workflowMode: 'standard',
        defaultProfileId: 'cheap-worker',
        configuredProfileIds: ['cheap-worker'],
        forcedProfileId: 'cheap-worker',
      },
    });
    expect(prompt).toContain('"taskId": "T002"');
    expect(prompt).toContain('"title": "Large parser rewrite"');
    expect(prompt).toContain('"selectedProfileId": "cheap-worker"');
    expect(prompt).toContain('do not reassign models');
    expect(prompt).not.toContain(hugeTaskBody);
    expect(prompt).not.toContain('currentCode');
    expect(prompt).not.toContain('description');
  });
});

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
