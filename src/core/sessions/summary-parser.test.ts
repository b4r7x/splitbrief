import { describe, expect, it } from 'vitest';
import { parsePersistedSummary } from './summary-parser.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';

describe('parsePersistedSummary', () => {
  it('accepts legacy summaries whose costBreakdown omits cache fields', () => {
    const legacy = makeSummary({
      costBreakdown: {
        hypotheticalCost: 1,
        actualPlannerCost: 0.5,
        actualImplementerCost: 0.2,
        totalActualCost: 0.7,
        savingsAmount: 0.3,
        savingsPercentage: 30,
        localCompletionRate: 0.5,
      },
    });

    const parsed = parsePersistedSummary(legacy);
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(parsed.summary.costBreakdown?.cacheReadSavings).toBeUndefined();
    expect(parsed.summary.costBreakdown?.cacheReadTokens).toBeUndefined();
    expect(parsed.summary.costBreakdown?.cacheWriteTokens).toBeUndefined();
  });
});
