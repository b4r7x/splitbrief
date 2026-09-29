import { describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import type { CustomRunnerRuntimePort } from '../../runners/types.js';
import { createPlanner, createReviewer } from '../../runners/factory.js';
import { createPlannerSeat } from './init-seats.js';

vi.mock('../../runners/factory.js', () => ({
  createPlanner: vi.fn(async () => makePlanner()),
  createReviewer: vi.fn(async () => makePlanner()),
  createImplementer: vi.fn(),
}));

describe('createPlannerSeat', () => {
  it("builds the planner and the reviewer with the run's global skills", async () => {
    const config = makeConfig({ reviewer: { kind: 'cli', tool: 'claude-code' } });
    const skillRoots = ['/home/me/.claude/skills/auth'];

    await createPlannerSeat({
      config,
      prepared: makePreparedExecution({
        projectDir: '/project',
        sessionId: 's',
        feature: 'f',
        config,
      }),
      customRuntime: {} as CustomRunnerRuntimePort,
      projectDir: '/project',
      initialSessionId: null,
      injectedPlanner: undefined,
      injectedReviewer: undefined,
      skillRoots,
    });

    expect(createPlanner).toHaveBeenCalledWith(config, expect.objectContaining({ skillRoots }));
    expect(createReviewer).toHaveBeenCalledWith(config, expect.objectContaining({ skillRoots }));
  });
});
