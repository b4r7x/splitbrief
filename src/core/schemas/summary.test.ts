import { describe, it, expect } from 'vitest';
import { costKnownFlags } from './summary.js';
import { calculateCostBreakdown } from '../../engine/providers/cost/breakdown.js';
import type { ModelCacheAccessor } from '../../engine/providers/model/resolution.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const usage = makeUsage({
  plannerInput: 100_000,
  plannerOutput: 40_000,
  reviewerInput: 20_000,
  reviewerOutput: 5_000,
});

const cache: ModelCacheAccessor = {
  getModelsDevCatalog: () => ({
    anthropic: {
      id: 'anthropic',
      models: {
        'claude-sonnet-4-5': {
          id: 'claude-sonnet-4-5',
          cost: { input: 3, output: 15 },
        },
      },
    },
  }),
  getProviderModels: () => null,
};

function breakdownFor(reviewer?: { tool: string; model?: string }) {
  return calculateCostBreakdown(
    {
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
      ...(reviewer !== undefined && { reviewerTool: reviewer.tool, reviewerModel: reviewer.model }),
    },
    cache,
  );
}

describe('costKnownFlags', () => {
  it('omits reviewerCostKnown when no reviewer is configured', () => {
    expect(costKnownFlags(breakdownFor())).not.toHaveProperty('reviewerCostKnown');
  });

  it('reports a priced reviewer as known', () => {
    const breakdown = breakdownFor({
      tool: 'custom-endpoint',
      model: 'anthropic/claude-sonnet-4-5',
    });

    expect(costKnownFlags(breakdown)).toMatchObject({ reviewerCostKnown: true });
  });

  it('reports an unpriced reviewer as unknown', () => {
    const breakdown = breakdownFor({ tool: 'openai-compatible', model: 'no-such-model' });

    expect(costKnownFlags(breakdown)).toMatchObject({ reviewerCostKnown: false });
  });
});
