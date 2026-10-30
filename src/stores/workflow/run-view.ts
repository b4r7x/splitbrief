import { EMPTY_RUN_VIEW, type RunView } from '../../core/run-view/reduce.js';
import { createStore, storeBase } from '../create-store.js';

const store = createStore<RunView>(EMPTY_RUN_VIEW);

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<RunView>): void {
  store.set({ ...EMPTY_RUN_VIEW, ...next });
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
export const _runViewInternal = { set: store.set };

export const runViewStore = { ...storeBase(store), __testReset };
