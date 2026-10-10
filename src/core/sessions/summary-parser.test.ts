import { describe, expect, it } from 'vitest';
import { parsePersistedSession } from './summary-parser.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';

describe('parsePersistedSession', () => {
  it('accepts summaries whose costBreakdown omits the optional cache fields', () => {
    const withoutCacheFields = makeSummary({
      costBreakdown: {
        actualPlannerCost: 0.5,
        actualImplementerCost: 0.2,
        totalActualCost: 0.7,
      },
    });

    const parsed = parsePersistedSession(
      makeSession({ status: 'complete', summary: withoutCacheFields }),
    );
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
    expect(parsed.session.summary?.costBreakdown?.cacheReadTokens).toBeUndefined();
    expect(parsed.session.summary?.costBreakdown?.cacheWriteTokens).toBeUndefined();
  });
});
