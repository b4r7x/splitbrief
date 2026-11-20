import { describe, expect, it } from 'vitest';
import { parsePersistedSession } from './summary-parser.js';
import { makeSession } from '#testing/helpers/factories/session.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';

describe('parsePersistedSession', () => {
  it('accepts summaries whose costBreakdown omits the optional cache fields', () => {
    const withoutCacheFields = makeSummary({});

    const parsed = parsePersistedSession(
      makeSession({ status: 'complete', summary: withoutCacheFields }),
    );
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok') return;
  });
});
