import { EMPTY_BRIEFS, type RunBriefs } from '../../core/run-view/briefs.js';
import { EMPTY_RUN_VIEW, type RunView } from '../../core/run-view/reduce.js';
import { createStore, storeBase } from '../create-store.js';

const store = createStore<RunView>(EMPTY_RUN_VIEW);

type RunViewSeed = Partial<Omit<RunView, 'briefs'>> & { briefs?: Partial<RunBriefs> };

// Test escape hatch — see docs/STORES-AND-UI.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: RunViewSeed): void {
  store.set({ ...EMPTY_RUN_VIEW, ...next, briefs: { ...EMPTY_BRIEFS, ...next?.briefs } });
}

// Test escape hatch — see docs/STORES-AND-UI.md#test-escape-hatches. Do not use outside tests.
export const _runViewInternal = { set: store.set };

export const runViewStore = { ...storeBase(store), __testReset };
