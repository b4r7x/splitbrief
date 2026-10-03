import type { Task } from '../../../src/core/schemas/task.js';
import type { TokenDelta } from '../../../src/core/schemas/tokens.js';
import type { Planner } from '../../../src/engine/planners/types.js';
import { ONE_SHOT_API_CAPS } from '../../../src/engine/planners/types.js';
import { makeRunnerCallResult } from '../factories/runner-call.js';
import { planFromTasks } from '../typed-planner.js';

export type FauxPlanScript = {
  tasks: Task[];
  usage?: TokenDelta | null;
  throws?: Error;
};

export type FauxEscalationScript = {
  success: boolean;
  output?: string;
  code?: string | null;
  usage?: TokenDelta | null;
  throws?: Error;
};

export type FauxPlannerState = {
  planCallCount: number;
  escalateFullCallCount: number;
  receivedPrompts: string[];
  receivedErrors: string[];
};

export function fauxPlanner(opts?: {
  plans?: FauxPlanScript[];
  escalations?: FauxEscalationScript[];
}): { planner: Planner; state: FauxPlannerState } {
  const plans = opts?.plans ?? [];
  const escalations = opts?.escalations ?? [];

  const state: FauxPlannerState = {
    planCallCount: 0,
    escalateFullCallCount: 0,
    receivedPrompts: [],
    receivedErrors: [],
  };

  const planner: Planner = {
    async escalateFull({ error }) {
      state.escalateFullCallCount++;
      state.receivedErrors.push(error);
      const script = escalations[(state.escalateFullCallCount - 1) % escalations.length];
      if (script?.throws) throw script.throws;
      return {
        success: script?.success ?? false,
        output: script?.output ?? '',
        code: script?.code ?? null,
        usage: script?.usage ?? null,
      };
    },

    async review(_prompt, _projectDir, _callbacks) {
      return { text: '', usage: null };
    },

    async summarize() {
      return { text: '', usage: null };
    },

    typedCall: (ctx) => ({
      seat: ctx.seat,
      typedOutput: 'fallback',
      canResume: false,
      async invoke({ prompt }) {
        state.planCallCount++;
        state.receivedPrompts.push(prompt);
        const script = plans[(state.planCallCount - 1) % plans.length];
        if (script?.throws) throw script.throws;
        const usage = script?.usage ?? null;
        return makeRunnerCallResult({
          status: 'completed',
          text: JSON.stringify({ result: planFromTasks(script?.tasks ?? []) }),
          usage:
            usage === null
              ? null
              : { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
        });
      },
    }),

    async injectUserTurn() {
      return { status: 'delivered', usage: null };
    },

    async isAvailable() {
      return true;
    },

    async getVersion() {
      return '1.0';
    },

    capabilities: ONE_SHOT_API_CAPS,
  };

  return { planner, state };
}
