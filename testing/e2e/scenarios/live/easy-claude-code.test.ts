import { describe, it } from 'vitest';
import {
  EASY_TIER,
  easyAssertions,
  liveModelPin,
  liveTierEnabled,
  liveToolBlocker,
  runLiveScenario,
} from '../../helpers/live-harness.js';

const itLive = liveTierEnabled('easy') ? it : it.skip;

describe('live easy: claude-code plans and implements', () => {
  itLive(
    'writes and validates the constant artifact through real claude-code calls',
    async (ctx) => {
      const blocker = await liveToolBlocker('claude-code');
      if (blocker !== null) return ctx.skip(blocker);
      const model = liveModelPin({ tool: 'claude-code', fallback: 'haiku' });
      await runLiveScenario(
        { ...EASY_TIER, tool: 'claude-code', model, tempPrefix: 'live-easy-claude-code' },
        easyAssertions,
      );
    },
    300_000,
  );
});
