import { describe, it } from 'vitest';
import {
  EASY_TIER,
  easyAssertions,
  liveModelPin,
  liveTierEnabled,
  runLiveScenario,
} from '../../helpers/live-harness.js';

const itLive = liveTierEnabled('easy') ? it : it.skip;

describe('live easy: claude-code plans and implements', () => {
  itLive(
    'writes and validates the constant artifact through real claude-code calls',
    async (ctx) => {
      const model = liveModelPin({ tool: 'claude-code', fallback: 'haiku' });
      const result = await runLiveScenario(
        { ...EASY_TIER, tool: 'claude-code', model, tempPrefix: 'live-easy-claude-code' },
        easyAssertions,
      );
      if (result.kind === 'skip') ctx.skip(result.reason);
    },
    300_000,
  );
});
