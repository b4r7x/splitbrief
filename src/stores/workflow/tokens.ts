import { createStore, storeBase } from '../create-store.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { phaseCostRole } from '../../core/phases.js';

interface PhaseTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  plannerInputTokens?: number | undefined;
  plannerOutputTokens?: number | undefined;
  plannerCacheReadTokens?: number | undefined;
  plannerCacheCreateTokens?: number | undefined;
  implementerInputTokens?: number | undefined;
  implementerOutputTokens?: number | undefined;
  implementerCacheReadTokens?: number | undefined;
  implementerCacheCreateTokens?: number | undefined;
  cost: number;
}

interface PerTaskTokens {
  totalTokens: number;
  cost: number;
  title: string;
}

export interface TokensState {
  localCount: number;
  escalatedCount: number;
  tokenUsage: TokenUsage | null;
  perPhase: Record<string, PhaseTokens>;
  perTask: Record<string, PerTaskTokens>;
  prediction: CostPrediction | null;
  completedTaskCount: number;
  pricingContext: PricingContext | null;
}

interface PricingContext {
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
}

const initial: TokensState = {
  localCount: 0,
  escalatedCount: 0,
  tokenUsage: null,
  perPhase: {},
  perTask: {},
  prediction: null,
  completedTaskCount: 0,
  pricingContext: null,
};

const store = createStore<TokensState>(initial);

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<TokensState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
export const _tokensInternal = { set: store.set };

export const tokensStore = {
  ...storeBase(store),
  __testReset,
};

const EMPTY_USAGE: TokenUsage = {
  plannerInput: 0,
  plannerOutput: 0,
  implementerInput: 0,
  implementerOutput: 0,
  escalationInput: 0,
  escalationOutput: 0,
};

function makeEmptyPhaseTokens(): PhaseTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    plannerInputTokens: 0,
    plannerOutputTokens: 0,
    plannerCacheReadTokens: 0,
    plannerCacheCreateTokens: 0,
    implementerInputTokens: 0,
    implementerOutputTokens: 0,
    implementerCacheReadTokens: 0,
    implementerCacheCreateTokens: 0,
    cost: 0,
  };
}

function clampDelta(value: number): number {
  return Math.max(0, value);
}

export function updateTokens(state: TokensState, event: EngineEvent): TokensState {
  switch (event.type) {
    case 'workflow_config':
      return {
        ...state,
        pricingContext: {
          plannerTool: event.plannerTool,
          implementerTool: event.implementerTool,
          plannerModel: event.plannerModel,
          implementerModel: event.implementerModel,
        },
      };

    case 'cost_update': {
      const prev = state.tokenUsage ?? EMPTY_USAGE;
      const curr = event.tokenUsage;
      const phase = event.phase;

      const existingPhase = state.perPhase[phase] ?? makeEmptyPhaseTokens();

      const plannerDelta = {
        input: clampDelta(curr.plannerInput - prev.plannerInput + curr.escalationInput - prev.escalationInput),
        output: clampDelta(curr.plannerOutput - prev.plannerOutput + curr.escalationOutput - prev.escalationOutput),
        cacheRead: clampDelta((curr.plannerCacheRead ?? 0) - (prev.plannerCacheRead ?? 0)),
        cacheCreate: clampDelta((curr.plannerCacheCreate ?? 0) - (prev.plannerCacheCreate ?? 0)),
      };
      const implementerDelta = {
        input: clampDelta(curr.implementerInput - prev.implementerInput),
        output: clampDelta(curr.implementerOutput - prev.implementerOutput),
        cacheRead: clampDelta((curr.implementerCacheRead ?? 0) - (prev.implementerCacheRead ?? 0)),
        cacheCreate: clampDelta((curr.implementerCacheCreate ?? 0) - (prev.implementerCacheCreate ?? 0)),
      };

      let inputDelta = 0;
      let outputDelta = 0;
      let cacheReadDelta = 0;
      let cacheCreateDelta = 0;
      let plannerInputDelta = 0;
      let plannerOutputDelta = 0;
      let plannerCacheReadDelta = 0;
      let plannerCacheCreateDelta = 0;
      let implementerInputDelta = 0;
      let implementerOutputDelta = 0;
      let implementerCacheReadDelta = 0;
      let implementerCacheCreateDelta = 0;
      const costRole = phaseCostRole(phase);

      if (costRole === 'planner') {
        inputDelta = plannerDelta.input;
        outputDelta = plannerDelta.output;
        cacheReadDelta = plannerDelta.cacheRead;
        cacheCreateDelta = plannerDelta.cacheCreate;
        plannerInputDelta = plannerDelta.input;
        plannerOutputDelta = plannerDelta.output;
        plannerCacheReadDelta = plannerDelta.cacheRead;
        plannerCacheCreateDelta = plannerDelta.cacheCreate;
      } else if (costRole === 'implementer') {
        inputDelta = implementerDelta.input + plannerDelta.input;
        outputDelta = implementerDelta.output + plannerDelta.output;
        cacheReadDelta = implementerDelta.cacheRead + plannerDelta.cacheRead;
        cacheCreateDelta = implementerDelta.cacheCreate + plannerDelta.cacheCreate;
        plannerInputDelta = plannerDelta.input;
        plannerOutputDelta = plannerDelta.output;
        plannerCacheReadDelta = plannerDelta.cacheRead;
        plannerCacheCreateDelta = plannerDelta.cacheCreate;
        implementerInputDelta = implementerDelta.input;
        implementerOutputDelta = implementerDelta.output;
        implementerCacheReadDelta = implementerDelta.cacheRead;
        implementerCacheCreateDelta = implementerDelta.cacheCreate;
      }

      const updatedPhase: PhaseTokens = {
        inputTokens: existingPhase.inputTokens + inputDelta,
        outputTokens: existingPhase.outputTokens + outputDelta,
        cacheReadTokens: existingPhase.cacheReadTokens + cacheReadDelta,
        cacheCreateTokens: existingPhase.cacheCreateTokens + cacheCreateDelta,
        plannerInputTokens: (existingPhase.plannerInputTokens ?? 0) + plannerInputDelta,
        plannerOutputTokens: (existingPhase.plannerOutputTokens ?? 0) + plannerOutputDelta,
        plannerCacheReadTokens: (existingPhase.plannerCacheReadTokens ?? 0) + plannerCacheReadDelta,
        plannerCacheCreateTokens: (existingPhase.plannerCacheCreateTokens ?? 0) + plannerCacheCreateDelta,
        implementerInputTokens: (existingPhase.implementerInputTokens ?? 0) + implementerInputDelta,
        implementerOutputTokens: (existingPhase.implementerOutputTokens ?? 0) + implementerOutputDelta,
        implementerCacheReadTokens: (existingPhase.implementerCacheReadTokens ?? 0) + implementerCacheReadDelta,
        implementerCacheCreateTokens: (existingPhase.implementerCacheCreateTokens ?? 0) + implementerCacheCreateDelta,
        cost: existingPhase.cost,
      };

      return {
        ...state,
        tokenUsage: event.tokenUsage,
        perPhase: { ...state.perPhase, [phase]: updatedPhase },
      };
    }

    case 'cost_prediction':
      return { ...state, prediction: event.prediction };

    case 'task_tokens': {
      const existing = state.perTask[event.taskId] ?? { totalTokens: 0, cost: 0, title: '' };
      const totalTokens = event.implementerTokens + event.escalationTokens;
      return {
        ...state,
        perTask: { ...state.perTask, [event.taskId]: { ...existing, totalTokens } },
      };
    }

    case 'task_started': {
      const existing = state.perTask[event.taskId] ?? { totalTokens: 0, cost: 0, title: '' };
      return {
        ...state,
        perTask: { ...state.perTask, [event.taskId]: { ...existing, title: event.title } },
      };
    }

    case 'task_completed': {
      let { localCount, escalatedCount } = state;
      if (event.method === 'local' || event.method === 'mcp-tool') localCount += 1;
      else if (
        event.method === 'escalated-intermediate' ||
        event.method === 'escalated-hint' ||
        event.method === 'escalated-full'
      ) {
        escalatedCount += 1;
      }
      return {
        ...state,
        localCount,
        escalatedCount,
        completedTaskCount: state.completedTaskCount + 1,
      };
    }

    default:
      return state;
  }
}
