import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import type { TaskId } from '../../../core/schemas/task.js';
import { buildPlannerEstimateReviewPrompt } from '../../spec/prompts/estimate-review.js';
import { buildPlannerEstimateReviewPacket } from './run.js';

type DeterministicEstimate = NonNullable<CostPrediction['deterministic']>;

const SENTINEL_DESCRIPTION = 'SENTINEL_ESTIMATE_REVIEW_DESCRIPTION';
const SENTINEL_CURRENT_CODE = 'SENTINEL_ESTIMATE_REVIEW_CURRENT_CODE';

const estimateBase: DeterministicEstimate = {
  taskCount: 3,
  taskFitCounts: { fits: 1, tight: 1, overflow: 1, unknown: 0 },
  contextConfidenceCounts: {
    contextExplicit: 2,
    contextDetected: 0,
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

function estimateWithRuntimeTaskFields(): DeterministicEstimate {
  const [first, ...rest] = estimateBase.tasks;
  if (!first) {
    throw new Error('expected tasks');
  }
  return {
    ...estimateBase,
    tasks: [
      { ...first, description: SENTINEL_DESCRIPTION, currentCode: SENTINEL_CURRENT_CODE },
      ...rest,
    ] as DeterministicEstimate['tasks'],
  };
}

describe('planner estimate review packet', () => {
  it('is compact and task-focused for the planner prompt', () => {
    const estimate = estimateWithRuntimeTaskFields();
    const config = {
      ...makeConfig(),
      implementerProfiles: {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': {
            kind: 'api' as const,
            provider: 'ollama',
            service: 'ollama' as const,
            offering: 'local' as const,
            apiBase: 'http://localhost:11434/v1',
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
    expect(JSON.stringify(packet.tasks)).not.toContain(SENTINEL_DESCRIPTION);
    expect(JSON.stringify(packet.tasks)).not.toContain(SENTINEL_CURRENT_CODE);
    expect(prompt).not.toContain(SENTINEL_DESCRIPTION);
    expect(prompt).not.toContain(SENTINEL_CURRENT_CODE);
  });
});
