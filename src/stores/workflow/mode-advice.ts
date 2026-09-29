import type { WorkflowMode } from '../../core/schemas/enums.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { AdvisorResult } from '../../engine/orchestrator/planning/mode-advisor.js';
import { createStore, storeBase } from '../create-store.js';

/**
 * The mode the run is on and the advice about it: the last mode planning resolved and the last
 * verdict given, `none` included. Both are kept beside the event log rather than read back from
 * it, because the log drops its oldest entries past its cap and both arrive near a run's start.
 */
export interface ModeAdviceState {
  mode: WorkflowMode | null;
  advice: AdvisorResult | null;
}

const initial: ModeAdviceState = { mode: null, advice: null };
const store = createStore<ModeAdviceState>(initial);

export function updateModeAdvice(state: ModeAdviceState, event: EngineEvent): ModeAdviceState {
  if (event.type === 'mode_resolved') return { ...state, mode: event.mode };
  if (event.type !== 'mode_advice') return state;
  return {
    ...state,
    advice: {
      kind: event.kind,
      risk: event.risk,
      currentMode: event.currentMode,
      suggestedMode: event.suggestedMode,
      confidence: event.confidence,
      factors: event.factors,
      missing: event.missing,
    },
  };
}

/**
 * A run read back from disk shows the mode it continues in and the advice its saved inputs earn
 * today. The log keeps what the advisor said when the run was live, and an older advisor may have
 * said something else.
 */
function settle(run: Readonly<{ mode: WorkflowMode; advice: AdvisorResult }>): void {
  store.set({ mode: run.mode, advice: run.advice });
}

function __testReset(next?: Partial<ModeAdviceState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
// Production use is limited to workflow/actions/ (the dispatcher).
export const _modeAdviceInternal = { set: store.set };

export const modeAdviceStore = {
  ...storeBase(store),
  settle,
  __testReset,
};
