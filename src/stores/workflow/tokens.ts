import { createStore, storeBase } from '../create-store.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { EngineEvent } from '../../engine/events/types.js';
import { calculateUsageCost, getProviderPricing } from '../../engine/providers/pricing.js';
import { modelCacheStore } from '../discovery/model-cache.js';

export interface PhaseTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  cost: number;
}

export interface PerTaskTokens {
  totalTokens: number;
  cost: number;
  title: string;
}

export interface TokensState {
  localCount: number;
  escalatedCount: number;
  tokenUsage: TokenUsage | null;
  perPhase: Record<string, PhaseTokens>;
  // projectedCost is NOT stored in state. Brief 03 (use-cost-stats.ts) derives it:
  //   projectedCost = (costBreakdown.totalActualCost / completedTaskCount) * totalTasks
  // when completedTaskCount > 0, else falls back to prediction.expectedCost.
  // Per-task cost in perTask is also derived in brief 04 from totalTokens and avg cost-per-token.
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
// Production use is limited to workflow/actions.ts (the dispatcher).
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
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, cost: 0 };
}

function clampDelta(value: number): number {
  return Math.max(0, value);
}

function isPlannerPhase(phase: string): boolean {
  return phase === 'planning' ||
    phase === 'researching' ||
    phase === 'specifying' ||
    phase === 'reviewing-spec' ||
    phase === 'clarifying' ||
    phase === 'constitution-check' ||
    phase === 'reviewing-plan' ||
    phase === 'reviewing-briefs';
}

function isImplementerPhase(phase: string): boolean {
  return phase === 'implementing' ||
    phase === 'validating-task' ||
    phase === 'escalating' ||
    phase === 'final-review';
}

function calculatePhaseCostDelta(
  context: PricingContext | null,
  planner: { input: number; output: number; cacheRead: number; cacheCreate: number },
  implementer: { input: number; output: number; cacheRead: number; cacheCreate: number },
): number {
  if (context === null) return 0;
  // Pass modelCacheStore so phase-cost math sees the same models-dev/runtime catalogs as
  // calculateCostBreakdown in useCostStats — a single source of truth for pricing.
  const plannerPricing = getProviderPricing(context.plannerTool, context.plannerModel, modelCacheStore);
  const implementerPricing = getProviderPricing(context.implementerTool, context.implementerModel, modelCacheStore);
  return calculateUsageCost(
    planner.input,
    planner.output,
    planner.cacheRead,
    planner.cacheCreate,
    plannerPricing,
  ) + calculateUsageCost(
    implementer.input,
    implementer.output,
    implementer.cacheRead,
    implementer.cacheCreate,
    implementerPricing,
  );
}

export function updateTokens(state: TokensState, event: EngineEvent): TokensState {
  if (event.type === 'workflow_config') {
    return {
      ...state,
      pricingContext: {
        plannerTool: event.plannerTool,
        implementerTool: event.implementerTool,
        plannerModel: event.plannerModel,
        implementerModel: event.implementerModel,
      },
    };
  }

  if (event.type === 'cost_update') {
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
    let costDelta = 0;

    if (isPlannerPhase(phase)) {
      inputDelta = plannerDelta.input;
      outputDelta = plannerDelta.output;
      cacheReadDelta = plannerDelta.cacheRead;
      cacheCreateDelta = plannerDelta.cacheCreate;
      costDelta = calculatePhaseCostDelta(state.pricingContext, plannerDelta, {
        input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
      });
    } else if (isImplementerPhase(phase)) {
      inputDelta = implementerDelta.input + plannerDelta.input;
      outputDelta = implementerDelta.output + plannerDelta.output;
      cacheReadDelta = implementerDelta.cacheRead + plannerDelta.cacheRead;
      cacheCreateDelta = implementerDelta.cacheCreate + plannerDelta.cacheCreate;
      costDelta = calculatePhaseCostDelta(state.pricingContext, plannerDelta, implementerDelta);
    }

    const updatedPhase: PhaseTokens = {
      inputTokens: existingPhase.inputTokens + inputDelta,
      outputTokens: existingPhase.outputTokens + outputDelta,
      cacheReadTokens: existingPhase.cacheReadTokens + cacheReadDelta,
      cacheCreateTokens: existingPhase.cacheCreateTokens + cacheCreateDelta,
      cost: existingPhase.cost + costDelta,
    };

    return {
      ...state,
      tokenUsage: event.tokenUsage,
      perPhase: { ...state.perPhase, [phase]: updatedPhase },
    };
  }

  if (event.type === 'cost_prediction') {
    return { ...state, prediction: event.prediction };
  }

  if (event.type === 'task_tokens') {
    const existing = state.perTask[event.taskId] ?? { totalTokens: 0, cost: 0, title: '' };
    const totalTokens = event.implementerTokens + event.escalationTokens;
    return {
      ...state,
      perTask: { ...state.perTask, [event.taskId]: { ...existing, totalTokens } },
    };
  }

  if (event.type === 'task_started') {
    const existing = state.perTask[event.taskId] ?? { totalTokens: 0, cost: 0, title: '' };
    return {
      ...state,
      perTask: { ...state.perTask, [event.taskId]: { ...existing, title: event.title } },
    };
  }

  if (event.type === 'task_completed') {
    let { localCount, escalatedCount } = state;
    if (event.method === 'local') localCount += 1;
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

  return state;
}
