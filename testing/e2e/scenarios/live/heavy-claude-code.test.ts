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

describe('live heavy: claude-code plans, implements and reviews', () => {
  itLive(
    'drives a standard-mode run with a compiled brief and a final review',
    async (ctx) => {
      const blocker = await liveToolBlocker('claude-code');
      if (blocker !== null) return ctx.skip(blocker);
      const model = liveModelPin({ tool: 'claude-code', fallback: 'haiku' });
      await runLiveScenario(
        { ...HEAVY_TIER, tool: 'claude-code', model, tempPrefix: 'live-heavy-claude-code' },
        heavyAssertions,
      );
    },
    900_000,
  );
});
