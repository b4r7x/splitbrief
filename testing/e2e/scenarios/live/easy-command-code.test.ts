import { describe, it } from 'vitest';
import {
  EASY_TIER,
  easyAssertions,
  liveModelPin,
  liveTierEnabled,
  runLiveScenario,
} from '../../helpers/live-harness.js';

const itLive = liveTierEnabled('easy') ? it : it.skip;

describe('live easy: command-code plans and implements', () => {
  itLive(
    'writes and validates the constant artifact through real command-code calls',
    async (ctx) => {
      const model = liveModelPin({ tool: 'command-code', fallback: 'deepseek/deepseek-v4-flash' });
      const result = await runLiveScenario(
        { ...EASY_TIER, tool: 'command-code', model, tempPrefix: 'live-easy-command-code' },
        easyAssertions,
      );
      if (result.kind === 'skip') ctx.skip(result.reason);
    },
    300_000,
  );
});
