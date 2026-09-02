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

describe('live easy: codex plans and implements', () => {
  itLive(
    'writes and validates the constant artifact through real codex calls',
    async (ctx) => {
      const blocker = await liveToolBlocker('codex');
      if (blocker !== null) return ctx.skip(blocker);
      const model = liveModelPin({ tool: 'codex', fallback: 'gpt-5.6-luna' });
      await runLiveScenario(
        { ...EASY_TIER, tool: 'codex', model, tempPrefix: 'live-easy-codex' },
        easyAssertions,
      );
    },
    300_000,
  );
});
