import { describe, it, expect, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { Planner } from '../../planners/types.js';
import type { Config } from '../../../core/schemas/config.js';
import {
  createTestSinks,
  makePassingTask,
  makePassingPlanner,
  auto,
  manual,
  runPhase as runPhaseHelper,
  type RunOpts,
} from '#testing/helpers/planning-phase.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function runPhase(opts: RunOpts = {}) {
  return runPhaseHelper(dirs, opts);
}

describe('runPlanningPhase — abort + continuation', () => {
  const abortCases: Array<{
    name: string;
    fnKey: 'plan' | 'quickPlan';
    workflow: Partial<Config['workflow']>;
    partialText: string;
    continuationText: string;
  }> = [
    {
      name: 'standard mode: plan() aborts → continuation carries partial + user text',
      fnKey: 'plan',
      workflow: auto(),
      partialText: 'partially generated spec...',
      continuationText: 'also use PostgreSQL 15',
    },
    {
      name: 'quick mode: quickPlan() aborts → continuation carries partial + user text',
      fnKey: 'quickPlan',
      workflow: manual('quick'),
      partialText: 'quick plan partial output',
      continuationText: 'add more detail',
    },
  ];

  it.each(abortCases)('$name', async ({ fnKey, workflow, partialText, continuationText }) => {
    const sinks = createTestSinks();
    let callCount = 0;
    const fn: Planner['plan'] = async ({ feature, callbacks: plannerCbs }) => {
      callCount++;
      if (callCount === 1) {
        plannerCbs.onOutput(partialText);
        sinks.abortTurn();
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      expect(feature).toContain(partialText);
      expect(feature).toContain(continuationText);
      return fnKey === 'quickPlan'
        ? {
            spec: '',
            plan: '',
            tasks: [makePassingTask()],
            usage: { inputTokens: 50, outputTokens: 25 },
          }
        : {
            spec: '# Full Spec',
            plan: '# Full Plan',
            tasks: [makePassingTask()],
            usage: { inputTokens: 100, outputTokens: 50 },
          };
    };

    const continuationPrompts: string[] = [];
    const onContinuationNeeded = async (partial: string) => {
      continuationPrompts.push(partial);
      return continuationText;
    };
    const { callbacks } = makeCallbacks({ onContinuationNeeded });
    const planner = makePassingPlanner({ [fnKey]: fn });

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow }),
      sinks,
    });

    expect(result.cancelled).toBe(false);
    expect(continuationPrompts).toEqual([partialText]);
    expect(callCount).toBe(2);
  });

  it('abort without onContinuationNeeded falls through to planning failure', async () => {
    const sinks = createTestSinks();
    let planCalls = 0;
    const plan = async () => {
      planCalls++;
      sinks.abortTurn();
      throw new DOMException('The user aborted a request.', 'AbortError');
    };
    const { callbacks } = makeCallbacks({ onContinuationNeeded: undefined });

    const { result } = await runPhase({
      planner: makePassingPlanner({ plan }),
      callbacks,
      config: makeConfig({ workflow: auto() }),
      sinks,
    });

    expect(result.cancelled).toBe(true);
    expect(planCalls).toBe(1);
  });
});
