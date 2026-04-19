import { createStore, storeBase } from '../create-store.js';

const SMALL_SCREEN_THRESHOLD = 120;

interface TerminalSize {
  cols: number;
  rows: number;
  isSmall: boolean;
}

const measure = (): TerminalSize => {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return { cols, rows, isSmall: cols < SMALL_SCREEN_THRESHOLD };
};

const store = createStore<TerminalSize>(measure);

function subscribeToResize(): () => void {
  const handler = () => store.set(measure());
  process.stdout.on('resize', handler);
  return () => {
    process.stdout.off('resize', handler);
  };
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<TerminalSize>): void {
  store.set(next ? { ...measure(), ...next } : measure());
}

export const terminalSizeStore = {
  ...storeBase(store),
  subscribeToResize,
  __testReset,
};
