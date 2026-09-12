import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  auto,
  makeBriefQualityFailureTask,
  makePassingPlanner,
  runPhase,
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
    const { result } = await runPhase(dirs, { config: makeConfig({ workflow }) });

    expect(result.disposition).toBe('ready-for-tasks');
    if (result.disposition !== 'ready-for-tasks') throw new Error('expected ready-for-tasks');
    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.state.phase).toBe('implementing');
  });

  it.each([
    { label: 'quick mode', workflow: auto('quick') },
    { label: 'standard mode with --approve none', workflow: auto('standard') },
  ])(
    '$label fails the run when the brief quality gate is still failing after repairs',
    async ({ workflow }) => {
      const { result, events } = await runPhase(dirs, {
        config: makeConfig({ workflow: { ...workflow, maxRetries: 0 } }),
        planner: makePassingPlanner({
          quickPlan: vi.fn().mockResolvedValue({
            spec: '',
            plan: '',
            tasks: [makeBriefQualityFailureTask()],
            usage: { inputTokens: 5, outputTokens: 1 },
          }),
          plan: vi.fn().mockResolvedValue({
            spec: '# Spec',
            plan: '# Plan',
            tasks: [makeBriefQualityFailureTask()],
            usage: { inputTokens: 5, outputTokens: 1 },
          }),
        }),
      });

      expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed' });
      expect(result.state.phase).toBe('idle');
      expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(1);
      expect(
        events.some(
          (event) => event.type === 'error' && event.message.includes('brief quality gate failed'),
        ),
      ).toBe(true);
    },
  );

  it('a producer that never reaches tasks surfaces the terminal disposition', async () => {
    const { result } = await runPhase(dirs, {
      config: makeConfig({ workflow: { mode: 'quick' } }),
      planner: makePassingPlanner({
        quickPlan: vi.fn().mockResolvedValue({
          spec: '',
          plan: '',
          tasks: [],
          usage: { inputTokens: 5, outputTokens: 1 },
        }),
      }),
    });

    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'failed' });
    expect(result.state.tasks).toEqual([]);
  });
});
