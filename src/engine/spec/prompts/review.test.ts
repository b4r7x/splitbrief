import { describe, expect, it } from 'vitest';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { triageLines } from './review.js';

describe('triageLines', () => {
  it('names the findings each fix task of a cycle answered', () => {
    expect(
      triageLines([
        {
          cycle: 1,
          at: '2026-10-03T00:00:00Z',
          inputIds: [],
          result: {
            fixTasks: [
              {
                ...makeTaskSpec({ id: 'T900', title: 'Guard the empty name' }),
                findingIds: ['F1', 'P2'],
              },
            ],
            rejected: [],
            verify: [],
            ask: null,
          },
        },
      ]),
    ).toBe('- cycle 1: fix tasks: Guard the empty name (F1, P2)');
  });
});
