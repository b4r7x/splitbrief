import { describe, it } from 'vitest';
import {
  EASY_TIER,
  easyAssertions,
  liveTierEnabled,
  runLiveScenario,
} from '../../helpers/live-harness.js';
import { resolveReleaseMatrixSeat } from '../../live/matrix.js';

const itLive = liveTierEnabled('easy') ? it : it.skip;

describe('live easy: opencode plans and implements', () => {
  itLive(
    'writes and validates the constant artifact through real opencode calls',
    async (ctx) => {
      const { model } = resolveReleaseMatrixSeat('opencode');
      const result = await runLiveScenario(
        { ...EASY_TIER, tool: 'opencode', model, tempPrefix: 'live-easy-opencode' },
        easyAssertions,
      );
      if (result.kind === 'skip') ctx.skip(result.reason);
    },
    300_000,
  );
});
