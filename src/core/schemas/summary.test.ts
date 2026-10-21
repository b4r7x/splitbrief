import { describe, it, expect } from 'vitest';
import { SummarySchema, costKnownFlags } from './summary.js';
import { calculateCostBreakdown } from '../../engine/providers/cost/breakdown.js';
import type { ModelCacheAccessor } from '../../engine/providers/model/resolution.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';

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

describe('SummarySchema seat identity kinds', () => {
  it('keeps the persisted seat kinds beside their tools through a round trip', () => {
    const parsed = SummarySchema.parse(
      makeSummary({
        plannerTool: 'claude-code',
        plannerKind: 'cli',
        implementerTool: 'opencode',
        implementerKind: 'api',
        reviewerTool: 'codex',
        reviewerKind: 'cli',
      }),
    );

    expect(parsed).toMatchObject({
      plannerKind: 'cli',
      implementerKind: 'api',
      reviewerKind: 'cli',
    });
  });

  it('keeps the axis words each seat ran at through a round trip', () => {
    const parsed = SummarySchema.parse(
      makeSummary({
        plannerTool: 'claude-code',
        plannerAxes: ['high'],
        implementerTool: 'codex',
        implementerAxes: ['low'],
        reviewerTool: 'opencode',
        reviewerAxes: [],
      }),
    );

    expect(parsed).toMatchObject({
      plannerAxes: ['high'],
      implementerAxes: ['low'],
      reviewerAxes: [],
    });
  });

  it('reads a legacy summary with no kinds as unknown, never as a default kind', () => {
    const parsed = SummarySchema.parse(
      makeSummary({ plannerTool: 'claude-code', implementerTool: 'opencode' }),
    );

    expect(parsed).not.toHaveProperty('plannerKind');
    expect(parsed).not.toHaveProperty('implementerKind');
    expect(parsed).not.toHaveProperty('reviewerKind');
    expect(parsed).not.toHaveProperty('plannerAxes');
    expect(parsed).not.toHaveProperty('implementerAxes');
  });

  it('rejects a persisted kind outside the runner kinds', () => {
    expect(() => SummarySchema.parse({ ...makeSummary(), plannerKind: 'local' })).toThrow();
  });
});
