import { createStore, storeBase } from '../create-store.js';

/**
 * What the blocks after the run's own events add to the transcript. The screen paints them, and
 * the keyboard has to scroll the document the screen painted — without these the keys measure a
 * transcript that stops at the last event and a closed run's ledger is unreachable from `home`.
 */
interface TranscriptTailState {
  rowCount: number;
  renderableUnits: number;
}

const initial: TranscriptTailState = { rowCount: 0, renderableUnits: 0 };

const store = createStore<TranscriptTailState>(initial);

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<TranscriptTailState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

export const transcriptTailStore = {
  ...storeBase(store),
  setMetrics: (metrics: TranscriptTailState) => {
    const current = store.get();
    if (
      current.rowCount === metrics.rowCount &&
      current.renderableUnits === metrics.renderableUnits
    ) {
      return;
    }
    store.set(metrics);
  },
  __testReset,
};
