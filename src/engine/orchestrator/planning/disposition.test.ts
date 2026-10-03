import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makePassingPlanner, runPlanningTurn } from '#testing/helpers/planning-phase.js';
import { typedCallFromTasks } from '#testing/helpers/typed-planner.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs.length = 0;
});

describe('planning disposition contract', () => {
  it('a planning pass returns exactly one explicit disposition', async () => {
    const { result } = await runPlanningTurn(dirs, { config: makeConfig() });

    expect(result.disposition).toBe('ready-for-tasks');
    if (result.disposition !== 'ready-for-tasks') throw new Error('expected ready-for-tasks');
    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.state.phase).toBe('implementing');
  });

  it('a plan with no task halts on its checks', async () => {
    const { result } = await runPlanningTurn(dirs, {
      config: makeConfig(),
      planner: makePassingPlanner({
        typedCall: typedCallFromTasks([], { inputTokens: 5, outputTokens: 1 }),
      }),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(result.state.tasks).toEqual([]);
    expect(result.state.pendingRecovery?.reason).toBe('plan-checks-failed');
  });
});
