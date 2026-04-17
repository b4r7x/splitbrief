import { createStore, storeBase } from '../create-store.js';

export interface InputHistoryState {
  entries: string[];
}

export const MAX_INPUT_HISTORY = 10;

const initial: InputHistoryState = { entries: [] };

const store = createStore<InputHistoryState>(initial);

function push(value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;

  store.set(state => {
    if (state.entries[0] === trimmed) return state;
    return {
      entries: [trimmed, ...state.entries.filter(entry => entry !== trimmed)].slice(0, MAX_INPUT_HISTORY),
    };
  });
}

function hydrate(entries: string[]): void {
  const deduped: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (deduped.includes(trimmed)) continue;
    deduped.push(trimmed);
    if (deduped.length >= MAX_INPUT_HISTORY) break;
  }
  store.set({ entries: deduped });
}

export const inputHistoryStore = {
  ...storeBase(store),
  push,
  hydrate,
};
