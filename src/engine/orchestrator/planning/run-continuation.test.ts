import { describe, it, expect, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { Planner } from '../../planners/types.js';
import type { Config } from '../../../core/schemas/config.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import {
  createTestSinks,
  REAL_TASKS_MD,
  makePassingTask,
  makePassingPlanner,
  auto,
  manual,
  runPlanningTurn as runPhaseHelper,
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
    workflow: Partial<Config['workflow']>;
    partialText: string;
    continuationText: string;
  }> = [
    {
      name: 'standard mode: an aborted call continues with the partial + user text',
      workflow: auto(),
      partialText: 'partially generated spec...',
      continuationText: 'also use PostgreSQL 15',
    },
    {
      name: 'quick mode: an aborted call continues with the partial + user text',
      workflow: manual('quick'),
      partialText: 'quick plan partial output',
      continuationText: 'add more detail',
    },
  ];

  it.each(abortCases)('$name', async ({ workflow, partialText, continuationText }) => {
    const sinks = createTestSinks();
    let callCount = 0;
    const continuedPhase: Planner['runPhase'] = async ({ call, inputs, callbacks: plannerCbs }) => {
      callCount++;
      if (callCount === 1) {
        plannerCbs.onOutput(partialText);
        sinks.abortTurn();
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      if (callCount === 2) {
        // The step's own prompt is rebuilt; the continuation trails it.
        expect(inputs.continuationTurn).toBeUndefined();
        expect(inputs.promptSuffix).toContain(partialText);
        expect(inputs.promptSuffix).toContain(continuationText);
      }
      return makePhaseCallResult({
        call,
        usage: { inputTokens: 100, outputTokens: 50 },
        ...(call === 'tasks' ? { text: REAL_TASKS_MD, tasks: [makePassingTask()] } : {}),
      });
    };

    const continuationPrompts: string[] = [];
    const onContinuationNeeded = async (partial: string) => {
      continuationPrompts.push(partial);
      return continuationText;
    };
    const { callbacks } = makeCallbacks({ onContinuationNeeded });
    const planner = makePassingPlanner({ runPhase: continuedPhase });

    const { result } = await runPhase({
      planner,
      callbacks,
      config: makeConfig({ workflow }),
      sinks,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(continuationPrompts).toEqual([partialText]);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('abort without onContinuationNeeded falls through to planning failure', async () => {
    const sinks = createTestSinks();
    let planCalls = 0;
    const abortingPhase: Planner['runPhase'] = async () => {
      planCalls++;
      sinks.abortTurn();
      throw new DOMException('The user aborted a request.', 'AbortError');
    };
    const { callbacks } = makeCallbacks({ onContinuationNeeded: undefined });

    const { result } = await runPhase({
      planner: makePassingPlanner({ runPhase: abortingPhase }),
      callbacks,
      config: makeConfig({ workflow: auto() }),
      sinks,
    });

    expect(result.disposition).toBe('terminal');
    expect(planCalls).toBe(1);
  });
});
