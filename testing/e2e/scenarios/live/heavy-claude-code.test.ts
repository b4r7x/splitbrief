import { describe, it } from 'vitest';
import {
  HEAVY_TIER,
  heavyAssertions,
  liveModelPin,
  liveTierEnabled,
  runLiveScenario,
} from '../../helpers/live-harness.js';

const itLive = liveTierEnabled('heavy') ? it : it.skip;

describe('live heavy: claude-code plans, implements and reviews', () => {
  itLive(
    'drives a standard-mode run with a compiled brief and a final review',
    async (ctx) => {
      const model = liveModelPin({ tool: 'claude-code', fallback: 'haiku' });
      const result = await runLiveScenario(
        { ...HEAVY_TIER, tool: 'claude-code', model, tempPrefix: 'live-heavy-claude-code' },
        heavyAssertions,
      );
      if (result.kind === 'skip') ctx.skip(result.reason);
    },
    900_000,
  );
});
