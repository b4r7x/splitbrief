import { plainUserMessage } from '../../../core/types/user-input.js';

import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makePlanProposal } from '#testing/helpers/factories/plan.js';
import { makeRunnerCallResult } from '#testing/helpers/factories/runner-call.js';
import {
  createTestSinks,
  makePassingPlanner,
  auto,
  runPlanningTurn,
  type RunOpts,
} from '#testing/helpers/planning-phase.js';
import { typedCallAnswering } from '#testing/helpers/typed-planner.js';
import { attachedMessage } from '#testing/helpers/user-message.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function runTurn(opts: RunOpts = {}) {
  return runPlanningTurn(dirs, opts);
}

describe('runPlanningPhase — abort + continuation', () => {
  it('runs a cut planning call again with what the user typed', async () => {
    const sinks = createTestSinks();
    const prompts: string[] = [];
    let message = plainUserMessage('');
    const planner = makePassingPlanner({
      typedCall: (ctx) => ({
        seat: ctx.seat,
        typedOutput: 'fallback',
        canResume: false,
        invoke: async ({ prompt }) => {
          prompts.push(prompt);
          if (prompts.length === 1) {
            message = attachedMessage(ctx.projectDir);
            sinks.abortTurn();
            throw new DOMException('The user aborted a request.', 'AbortError');
          }
          return makeRunnerCallResult({
            status: 'completed',
            text: JSON.stringify({ result: makePlanProposal() }),
          });
        },
      }),
    });
    const onContinuationNeeded = vi.fn(async () => message);

    const { result } = await runTurn({
      planner,
      callbacks: makeCallbacks({ onContinuationNeeded }).callbacks,
      config: makeConfig({ workflow: auto() }),
      sinks,
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(onContinuationNeeded).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`The user says: ${message.text}`);
  });

  it('abort without onContinuationNeeded falls through to planning failure', async () => {
    const sinks = createTestSinks();
    let planCalls = 0;
    const aborting = typedCallAnswering(() => {
      planCalls++;
      sinks.abortTurn();
      throw new DOMException('The user aborted a request.', 'AbortError');
    });
    const { callbacks } = makeCallbacks({ onContinuationNeeded: undefined });

    const { result } = await runTurn({
      planner: makePassingPlanner({ typedCall: aborting }),
      callbacks,
      config: makeConfig({ workflow: auto() }),
      sinks,
    });

    expect(result.disposition).toBe('terminal');
    expect(planCalls).toBe(1);
  });
});
