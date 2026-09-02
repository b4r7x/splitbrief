import { describe, it } from 'vitest';
import {
  HEAVY_TIER,
  heavyAssertions,
  liveModelPin,
  liveTierEnabled,
  liveToolBlocker,
  runLiveScenario,
} from '../../helpers/live-harness.js';

const itLive = liveTierEnabled('heavy') ? it : it.skip;

describe('live heavy: command-code plans, implements and reviews', () => {
  itLive(
    'drives a standard-mode run with a compiled brief and a final review',
    async (ctx) => {
      const blocker = await liveToolBlocker('command-code');
      if (blocker !== null) return ctx.skip(blocker);
      const model = liveModelPin({ tool: 'command-code', fallback: 'deepseek/deepseek-v4-flash' });
      await runLiveScenario(
        { ...HEAVY_TIER, tool: 'command-code', model, tempPrefix: 'live-heavy-command-code' },
        heavyAssertions,
      );
    },
    900_000,
  );
});
