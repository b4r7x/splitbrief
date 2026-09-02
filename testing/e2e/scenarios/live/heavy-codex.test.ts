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

describe('live heavy: codex plans, implements and reviews', () => {
  itLive(
    'drives a standard-mode run with a compiled brief and a final review',
    async (ctx) => {
      const blocker = await liveToolBlocker('codex');
      if (blocker !== null) return ctx.skip(blocker);
      const model = liveModelPin({ tool: 'codex', fallback: 'gpt-5.6-luna' });
      await runLiveScenario(
        { ...HEAVY_TIER, tool: 'codex', model, tempPrefix: 'live-heavy-codex' },
        heavyAssertions,
      );
    },
    900_000,
  );
});
