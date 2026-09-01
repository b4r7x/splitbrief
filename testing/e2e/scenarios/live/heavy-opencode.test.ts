import { describe, it } from 'vitest';
import {
  HEAVY_TIER,
  heavyAssertions,
  liveModelPin,
  liveTierEnabled,
  liveToolBlocker,
  openCodeFreeModelId,
  runLiveScenario,
} from '../../helpers/live-harness.js';

const itLive = liveTierEnabled('heavy') ? it : it.skip;

describe('live heavy: opencode plans, implements and reviews', () => {
  itLive(
    'drives a standard-mode run with a compiled brief and a final review',
    async (ctx) => {
      const blocker = await liveToolBlocker('opencode');
      if (blocker !== null) return ctx.skip(blocker);
      const model = liveModelPin({ tool: 'opencode', fallback: openCodeFreeModelId() });
      if (model === undefined) return ctx.skip('opencode exposes no free model id');
      await runLiveScenario(
        { ...HEAVY_TIER, tool: 'opencode', model, tempPrefix: 'live-heavy-opencode' },
        heavyAssertions,
      );
    },
    900_000,
  );
});
