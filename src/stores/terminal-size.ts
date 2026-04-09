import { createStore, storeBase } from './create-store.js';

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

process.stdout.on('resize', () => store.set(measure()));

export const terminalSizeStore = {
  ...storeBase(store),
};
