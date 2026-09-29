import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import type { RunPhaseInput } from '../../planners/types.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  auto,
  makeBriefQualityFailureTask,
  makePassingPlanner,
  runPlanningTurn,
} from '#testing/helpers/planning-phase.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs.length = 0;
});

describe('cross-mode disposition contract', () => {
  it.each([
    ['quick', { mode: 'quick' }],
    ['standard', { mode: 'standard' }],
    ['speckit', { mode: 'speckit' }],
  ] as const)('%s mode returns exactly one explicit disposition', async (_label, workflow) => {
    const { result } = await runPlanningTurn(dirs, { config: makeConfig({ workflow }) });

    expect(result.disposition).toBe('ready-for-tasks');
    if (result.disposition !== 'ready-for-tasks') throw new Error('expected ready-for-tasks');
    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.state.phase).toBe('implementing');
  });

  // The briefs are measured where they wait: at the plan gate in a run whose steps open one, and in
  // planning, the phase that compiled them, in every other run.
  it.each([
    [{ mode: 'quick' }, 'planning'],
    [{ mode: 'standard' }, 'planning'],
    [{ mode: 'standard', approve: 'none' }, 'planning'],
    [{ mode: 'speckit', approve: 'spec' }, 'planning'],
    [{ mode: 'standard', approve: 'plan' }, 'reviewing-plan'],
    [{ mode: 'speckit' }, 'reviewing-plan'],
  ] as const)('%o measures its briefs in %s', async (workflow, phase) => {
    const { result, events } = await runPlanningTurn(dirs, { config: makeConfig({ workflow }) });

    expect(result.state.phase).toBe('implementing');
    expect(events.find((event) => event.type === 'brief_quality_passed')?.phase).toBe(phase);
    expect(events.some((event) => event.phase === 'reviewing-plan')).toBe(
      phase === 'reviewing-plan',
    );
  });

  it.each([
    { label: 'quick mode', workflow: auto('quick') },
    { label: 'standard mode with --approve none', workflow: auto('standard') },
  ])(
    '$label halts the run when the brief quality gate is still failing after repairs',
    async ({ workflow }) => {
      const { result, events } = await runPlanningTurn(dirs, {
        config: makeConfig({ workflow: { ...workflow, maxRetries: 0 } }),
        planner: makePassingPlanner({
          runPhase: vi.fn(async ({ call }: RunPhaseInput) =>
            makePhaseCallResult({
              call,
              usage: { inputTokens: 5, outputTokens: 1 },
              ...(call === 'tasks' ? { tasks: [makeBriefQualityFailureTask()] } : {}),
            }),
          ),
        }),
      });

      expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
      expect(result.state.closed).toBeUndefined();
      expect(result.state.pendingRecovery).toMatchObject({
        reason: 'brief-quality-unrepaired',
        seat: 'plan',
        recommendedAction: 'revise',
      });
      expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(1);
      expect(events.some((event) => event.type === 'recovery_prompted')).toBe(true);
    },
  );

  it('a producer that never reaches tasks surfaces the terminal disposition', async () => {
    const { result } = await runPlanningTurn(dirs, {
      config: makeConfig({ workflow: { mode: 'quick' } }),
      planner: makePassingPlanner({
        runPhase: vi.fn(async ({ call }: RunPhaseInput) =>
          makePhaseCallResult({
            call,
            usage: { inputTokens: 5, outputTokens: 1 },
            ...(call === 'tasks' ? { tasks: [] } : {}),
          }),
        ),
      }),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(result.state.tasks).toEqual([]);
    expect(result.state.pendingRecovery?.reason).toBe('planner-returned-no-briefs');
  });
});
