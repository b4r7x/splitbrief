import type { Task } from '../../../src/core/schemas/task.js';
import type { TokenDelta } from '../../../src/core/schemas/tokens.js';
import type {
  Planner,
} from '../../../src/engine/planners/types.js';
import { ONE_SHOT_API_CAPS } from '../../../src/engine/planners/types.js';

export type FauxPlanScript = {
  tasks: Task[];
  spec?: string;
  plan?: string;
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
  quickPlanCallCount: number;
  escalateHintCallCount: number;
  escalateFullCallCount: number;
  receivedFeatures: string[];
  receivedErrors: string[];
};

export function fauxPlanner(opts?: {
  plans?: FauxPlanScript[];
  escalations?: FauxEscalationScript[];
  quickPlans?: FauxPlanScript[];
}): { planner: Planner; state: FauxPlannerState } {
  const plans = opts?.plans ?? [];
  const escalations = opts?.escalations ?? [];
  const quickPlans = opts?.quickPlans ?? [];

  const state: FauxPlannerState = {
    planCallCount: 0,
    quickPlanCallCount: 0,
    escalateHintCallCount: 0,
    escalateFullCallCount: 0,
    receivedFeatures: [],
    receivedErrors: [],
  };

  const planner: Planner = {
    async plan(feature, _projectDir, _callbacks, _skillsContext, _codebaseContext) {
      state.planCallCount++;
      state.receivedFeatures.push(feature);
      const script = plans[(state.planCallCount - 1) % plans.length];
      if (script?.throws) throw script.throws;
      return {
        spec: script?.spec ?? '',
        plan: script?.plan ?? '',
        tasks: script?.tasks ?? [],
        usage: script?.usage ?? null,
      };
    },

    async regenerate(_prompt, _artifactType, _projectDir, _callbacks) {
      return { text: '', usage: null };
    },

    async escalateHint(_task, error, _projectDir, _callbacks) {
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

    async escalateFull(_task, error, _projectDir, _callbacks) {
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

    async quickPlan(feature, _projectDir, _callbacks, _codebaseContext) {
      state.quickPlanCallCount++;
      state.receivedFeatures.push(feature);
      const script = quickPlans[(state.quickPlanCallCount - 1) % quickPlans.length];
      if (script?.throws) throw script.throws;
      return {
        spec: script?.spec ?? '',
        plan: script?.plan ?? '',
        tasks: script?.tasks ?? [],
        usage: script?.usage ?? null,
      };
    },

    async review(_prompt, _projectDir, _callbacks) {
      return { text: '', usage: null };
    },

    async summarize() {
      return '';
    },

    async injectUserTurn(_text, _projectDir) {
      return Promise.resolve();
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
