import { describe, expect, it } from 'vitest';
import { makeSession } from '#testing/helpers/factories/session.js';
import { filterSession } from './search.js';

describe('filterSession', () => {
  it('finds a ready row by its displayed status', () => {
    const ready = makeSession({ apply: 'ready' });
    const applied = makeSession({ status: 'complete', apply: 'applied' });

    expect([ready, applied].filter((session) => filterSession(session, 'ready to apply'))).toEqual([
      ready,
    ]);
  });
});
