import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  auto,
  makePassingPlanner,
  makePassingTask,
  runPhase as runPhaseHelper,
} from '#testing/helpers/planning-phase.js';
import { MODE_UPGRADE } from '../../../core/pipeline-spec/modes.js';
import type { EngineEvent } from '../../events/types.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

// The feature text is deliberately one neutral word: the keyword advisor stays
// silent on it, so every mode_advice below is the plan-size advice.
const FEATURE = 'test-feature';

function producing(count: number) {
  const tasks = Array.from({ length: count }, (_, i) =>
    makePassingTask(`T${String(i + 1).padStart(3, '0')}`),
  );
  return vi
    .fn()
    .mockResolvedValue({ spec: '', plan: '', tasks, usage: { inputTokens: 1, outputTokens: 1 } });
}

function modeAdvice(events: readonly EngineEvent[]) {
  return events.filter((e) => e.type === 'mode_advice');
}

describe('runPlanningPhase — plan-size advice', () => {
  it('a plan over the standard brief cap advises stopping', async () => {
    const over = MODE_UPGRADE.standardCap + 1;
    const { events } = await runPhaseHelper(dirs, {
      feature: FEATURE,
      config: makeConfig({ workflow: auto('standard') }),
      planner: makePassingPlanner({ plan: producing(over) }),
    });

    expect(modeAdvice(events)).toMatchObject([
      {
        kind: 'stop',
        suggestedMode: 'standard',
        factors: [`${over} briefs over the ${MODE_UPGRADE.standardCap} cap`],
      },
    ]);
  });

  it('a quick plan past the upgrade thresholds advises standard', async () => {
    const { events } = await runPhaseHelper(dirs, {
      feature: FEATURE,
      config: makeConfig({ workflow: auto('quick') }),
      planner: makePassingPlanner({
        quickPlan: producing(MODE_UPGRADE.quickToStandard.briefs + 1),
      }),
    });

    expect(modeAdvice(events)).toMatchObject([{ kind: 'upgrade', suggestedMode: 'standard' }]);
  });

  it('a plan at the standard cap advises nothing', async () => {
    const { events } = await runPhaseHelper(dirs, {
      feature: FEATURE,
      config: makeConfig({ workflow: auto('standard') }),
      planner: makePassingPlanner({ plan: producing(MODE_UPGRADE.standardCap) }),
    });

    expect(modeAdvice(events)).toEqual([]);
  });
});
