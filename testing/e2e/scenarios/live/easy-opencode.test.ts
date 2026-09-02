import { describe, it } from 'vitest';
import {
  EASY_TIER,
  easyAssertions,
  liveModelPin,
  liveTierEnabled,
  liveToolBlocker,
  openCodeFreeModelId,
  runLiveScenario,
} from '../../helpers/live-harness.js';

const itLive = liveTierEnabled('easy') ? it : it.skip;

describe('live easy: opencode plans and implements', () => {
  itLive(
    'writes and validates the constant artifact through real opencode calls',
    async (ctx) => {
      const blocker = await liveToolBlocker('opencode');
      if (blocker !== null) return ctx.skip(blocker);
      const model = liveModelPin({ tool: 'opencode', fallback: openCodeFreeModelId() });
      if (model === undefined) return ctx.skip('opencode exposes no free model id');
      await runLiveScenario(
        { ...EASY_TIER, tool: 'opencode', model, tempPrefix: 'live-easy-opencode' },
        easyAssertions,
      );
    },
    300_000,
  );
});
