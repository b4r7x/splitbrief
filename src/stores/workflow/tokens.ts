import { createStore, storeBase } from '../create-store.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { EngineEvent } from '../../engine/events/types.js';

export interface PhaseTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
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
}

const initial: TokensState = {
  localCount: 0,
  escalatedCount: 0,
  tokenUsage: null,
  perPhase: {},
  perTask: {},
  prediction: null,
  completedTaskCount: 0,
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

export function updateTokens(state: TokensState, event: EngineEvent): TokensState {
  if (event.type === 'cost_update') {
    const prev = state.tokenUsage ?? {
      plannerInput: 0, plannerOutput: 0,
      implementerInput: 0, implementerOutput: 0,
      escalationInput: 0, escalationOutput: 0,
    };
    const curr = event.tokenUsage;
    const phase = event.phase;

    // Derive token deltas by diffing against previous snapshot.
    // For planning phases: accumulate planner input/output and planner cache tokens.
    // For implementing phases: accumulate implementer+escalation input/output and implementer cache tokens.
    const existingPhase = state.perPhase[phase] ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 };

    let inputDelta: number;
    let outputDelta: number;
    let cacheReadDelta: number;

    if (phase.includes('planning') || phase.includes('researching') || phase.includes('specifying') || phase.includes('reviewing-spec') || phase.includes('clarifying') || phase.includes('constitution-check') || phase.includes('reviewing-plan') || phase === 'reviewing-briefs') {
      inputDelta = (curr.plannerInput - prev.plannerInput);
      outputDelta = (curr.plannerOutput - prev.plannerOutput);
      cacheReadDelta = ((curr.plannerCacheRead ?? 0) - (prev.plannerCacheRead ?? 0));
    } else if (phase.includes('implementing') || phase.includes('validating-task') || phase.includes('escalating') || phase.includes('final-review')) {
      inputDelta = (curr.implementerInput - prev.implementerInput) + (curr.escalationInput - prev.escalationInput);
      outputDelta = (curr.implementerOutput - prev.implementerOutput) + (curr.escalationOutput - prev.escalationOutput);
      cacheReadDelta = ((curr.implementerCacheRead ?? 0) - (prev.implementerCacheRead ?? 0));
    } else {
      inputDelta = 0;
      outputDelta = 0;
      cacheReadDelta = 0;
    }

    const updatedPhase: PhaseTokens = {
      inputTokens: existingPhase.inputTokens + Math.max(0, inputDelta),
      outputTokens: existingPhase.outputTokens + Math.max(0, outputDelta),
      cacheReadTokens: existingPhase.cacheReadTokens + Math.max(0, cacheReadDelta),
      cost: existingPhase.cost,
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
