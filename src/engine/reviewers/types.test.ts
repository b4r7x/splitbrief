import { expect, expectTypeOf, it } from 'vitest';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import { createPlannerBase } from '../planners/base.js';
import { ONE_SHOT_API_CAPS, type Planner } from '../planners/types.js';
import type { Reviewer } from './types.js';

it('lets a planner hold the review seat', async () => {
  expectTypeOf<Planner>().toExtend<Reviewer>();

  const reviewer: Reviewer = createPlannerBase({
    invokePlan: async () => makeRunnerCallResult({ status: 'completed', text: '' }),
    invokeEscalate: async () =>
      makeRunnerCallResult({
        status: 'completed',
        text: 'VERDICT: ship',
        usage: { inputTokens: 120, outputTokens: 40 },
      }),
    isAvailable: async () => true,
    capabilities: ONE_SHOT_API_CAPS,
  });

  await expect(
    reviewer.review('review the run diff', '/project', { onOutput: () => {} }),
  ).resolves.toEqual({
    text: 'VERDICT: ship',
    usage: { inputTokens: 120, outputTokens: 40 },
  });
});
