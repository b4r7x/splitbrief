import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import type { RunPhaseInput } from '../../planners/types.js';
import {
  auto,
  makePassingPlanner,
  makePassingTask,
  prepareState,
  runOwnedPlanningPhase,
  runPlanningTurn as runPhaseHelper,
} from '#testing/helpers/planning-phase.js';
import { MODE_UPGRADE } from '../../../core/pipeline-spec/modes.js';
import { adviseRun } from './mode-advisor.js';
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
  return vi.fn(async ({ call }: RunPhaseInput) =>
    makePhaseCallResult({
      call,
      usage: { inputTokens: 1, outputTokens: 1 },
      ...(call === 'tasks' ? { tasks } : {}),
    }),
  );
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
      planner: makePassingPlanner({ runPhase: producing(over) }),
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
        runPhase: producing(MODE_UPGRADE.quickToStandard.briefs + 1),
      }),
    });

    expect(modeAdvice(events)).toMatchObject([{ kind: 'upgrade', suggestedMode: 'standard' }]);
  });

  it('a plan at the standard cap advises nothing', async () => {
    const { events } = await runPhaseHelper(dirs, {
      feature: FEATURE,
      config: makeConfig({ workflow: auto('standard') }),
      planner: makePassingPlanner({ runPhase: producing(MODE_UPGRADE.standardCap) }),
    });

    expect(modeAdvice(events)).toEqual([]);
  });
});

describe('runPlanningPhase — the advisor reads the @ context', () => {
  const VAGUE = 'rewrite the onboarding page copy for launch';
  const CONTEXT = '## T001\n- the banner renders on mobile\n- `npm test` passes';

  it('reports the missing validation hint when the sentence stands alone', async () => {
    const { events } = await runPhaseHelper(dirs, {
      feature: VAGUE,
      state: { ...prepareState(), feature: VAGUE },
      config: makeConfig({ workflow: auto('standard') }),
    });

    expect(modeAdvice(events)).toMatchObject([
      { kind: 'missing-context', missing: ['no validation hint'] },
    ]);
  });

  it('is silent once the @ context supplies it', async () => {
    const { events } = await runPhaseHelper(dirs, {
      feature: VAGUE,
      state: { ...prepareState(), feature: VAGUE },
      plannerContext: CONTEXT,
      config: makeConfig({ workflow: auto('standard') }),
    });

    expect(modeAdvice(events)).toEqual([]);
  });

  it('reads a scenario id in the @ context as a name, not a risk', async () => {
    const { events } = await runPhaseHelper(dirs, {
      feature: VAGUE,
      state: { ...prepareState(), feature: VAGUE },
      plannerContext: `${CONTEXT}\n- render \`overlay-picker-auth-config-owned\``,
      config: makeConfig({ workflow: auto('standard') }),
    });

    expect(modeAdvice(events)).toEqual([]);
  });
});

describe('runPlanningPhases — saved-input advice', () => {
  it('counts @ context once and agrees with the advice from saved inputs', async () => {
    const feature = 'update footer copy in src/readme.md';
    const plannerContext = 'Fix typo in docs, then run tests now';
    const state = { ...prepareState(), plannerContext };
    const { events, result } = await runOwnedPlanningPhase(dirs, {
      feature,
      plannerContext,
      state,
      config: makeConfig({
        workflow: auto('standard'),
        codebase: { enabled: false, tokenBudget: 4000 },
      }),
    });
    const [liveAdvice] = modeAdvice(events);
    const savedAdvice = adviseRun({
      feature,
      plannerContext,
      mode: 'standard',
      tasks: result.tasks,
    });

    expect(savedAdvice).toMatchObject({ kind: 'downgrade', risk: 'trivial' });
    expect(liveAdvice).toMatchObject(savedAdvice);
  });
});
