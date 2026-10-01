import type { Task } from '../../../src/core/schemas/task.js';
import type { TokenDelta } from '../../../src/core/schemas/tokens.js';
import type { Planner } from '../../../src/engine/planners/types.js';
import { ONE_SHOT_API_CAPS } from '../../../src/engine/planners/types.js';
import { makePhaseCallResult } from '../factories/phase-call.js';

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
  phaseCallCount: number;
  escalateHintCallCount: number;
  escalateFullCallCount: number;
  receivedFeatures: string[];
  receivedErrors: string[];
};

export function fauxPlanner(opts?: {
  phases?: FauxPlanScript[];
  escalations?: FauxEscalationScript[];
}): { planner: Planner; state: FauxPlannerState } {
  const phases = opts?.phases ?? [];
  const escalations = opts?.escalations ?? [];

  const state: FauxPlannerState = {
    phaseCallCount: 0,
    escalateHintCallCount: 0,
    escalateFullCallCount: 0,
    receivedFeatures: [],
    receivedErrors: [],
  };

  const planner: Planner = {
    async runPhase({ call, inputs }) {
      state.phaseCallCount++;
      state.receivedFeatures.push(inputs.feature);
      const script = phases[(state.phaseCallCount - 1) % phases.length];
      if (script?.throws) throw script.throws;
      return makePhaseCallResult({
        call,
        usage: script?.usage ?? null,
        ...(call === 'tasks' ? { tasks: script?.tasks ?? [] } : {}),
      });
    },

    async regenerate() {
      return { text: '', usage: null };
    },

    async escalateHint({ error }) {
      state.escalateHintCallCount++;
      state.receivedErrors.push(error);
      const script = escalations[(state.escalateHintCallCount - 1) % escalations.length];
      if (script?.throws) throw script.throws;
      return {
        success: script?.success ?? false,
        output: script?.output ?? '',
        code: script?.code ?? null,
        usage: script?.usage ?? null,
      };
    },

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

    typedCall: () => {
      throw new Error('typedCall is not stubbed');
    },

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
