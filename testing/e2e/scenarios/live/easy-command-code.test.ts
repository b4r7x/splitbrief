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

describe('live easy: command-code plans and implements', () => {
  itLive(
    'writes and validates the constant artifact through real command-code calls',
    async (ctx) => {
      const blocker = await liveToolBlocker('command-code');
      if (blocker !== null) return ctx.skip(blocker);
      const model = liveModelPin({ tool: 'command-code', fallback: 'deepseek/deepseek-v4-flash' });
      await runLiveScenario(
        { ...EASY_TIER, tool: 'command-code', model, tempPrefix: 'live-easy-command-code' },
        easyAssertions,
      );
    },
    300_000,
  );
});
