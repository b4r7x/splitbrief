import { describe, it } from 'vitest';
import {
  HEAVY_TIER,
  heavyAssertions,
  liveTierEnabled,
  runLiveScenario,
} from '../../helpers/live-harness.js';
import { resolveReleaseMatrixSeat } from '../../live/matrix.js';

const itLive = liveTierEnabled('heavy') ? it : it.skip;

describe('live heavy: opencode plans, implements and reviews', () => {
  itLive(
    'drives a standard-mode run with a compiled brief and a final review',
    async (ctx) => {
      const { model } = resolveReleaseMatrixSeat('opencode');
      const result = await runLiveScenario(
        { ...HEAVY_TIER, tool: 'opencode', model, tempPrefix: 'live-heavy-opencode' },
        heavyAssertions,
      );
      if (result.kind === 'skip') ctx.skip(result.reason);
    },
    900_000,
  );
});
