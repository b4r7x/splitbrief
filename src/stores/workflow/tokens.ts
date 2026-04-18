import { createStore, storeBase } from '../create-store.js';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { TuiEvent } from '../../features/workflow/types.js';

export interface TokensState {
  localCount: number;
  escalatedCount: number;
  tokenUsage: TokenUsage | null;
}

const initial: TokensState = {
  localCount: 0,
  escalatedCount: 0,
  tokenUsage: null,
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

export function updateTokens(state: TokensState, event: TuiEvent): TokensState {
  if (event.type === 'cost-update') {
    return { ...state, tokenUsage: event.tokenUsage };
  }
  if (event.type === 'task-complete') {
    let { localCount, escalatedCount } = state;
    if (event.method === 'local') localCount += 1;
    else if (
      event.method === 'escalated-intermediate' ||
      event.method === 'escalated-hint' ||
      event.method === 'escalated-full'
    ) {
      escalatedCount += 1;
    }
    if (localCount === state.localCount && escalatedCount === state.escalatedCount) return state;
    return { ...state, localCount, escalatedCount };
  }
  return state;
}
