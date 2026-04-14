import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStore, storeBase } from './create-store.js';
import { writeSecureFile } from '../utils/fs.js';
import { TINY_SPEC_DIR } from '../core/paths.js';

export type InputHistoryScope = 'home';

interface InputHistoryState {
  entriesByScope: Record<InputHistoryScope, string[]>;
}

const MAX_INPUT_HISTORY = 10;
const HISTORY_FILE = join(homedir(), TINY_SPEC_DIR, 'history');

function initialState(): InputHistoryState {
  return {
    entriesByScope: {
      home: [],
    },
  };
}

const store = createStore<InputHistoryState>(initialState);

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function save(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const entries = store.get().entriesByScope.home;
      writeSecureFile(HISTORY_FILE, entries.join('\n'));
    } catch {
      // write failures must not propagate as unhandled rejections from the timer callback
    }
  }, 300);
}

function load(): void {
  try {
    const content = readFileSync(HISTORY_FILE, 'utf-8');
    const entries = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .slice(0, MAX_INPUT_HISTORY);
    store.set(state => ({ ...state, entriesByScope: { ...state.entriesByScope, home: entries } }));
  } catch {
    // Missing file is fine — start with empty history
  }
}

function push(scope: InputHistoryScope, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;

  store.set(state => {
    const current = state.entriesByScope[scope];
    if (current[0] === trimmed) return state;

    return {
      ...state,
      entriesByScope: {
        ...state.entriesByScope,
        [scope]: [trimmed, ...current.filter(entry => entry !== trimmed)].slice(0, MAX_INPUT_HISTORY),
      },
    };
  });

  save();
}

function getEntries(scope: InputHistoryScope): string[] {
  return store.get().entriesByScope[scope];
}

export const inputHistoryStore = {
  ...storeBase(store),
  push,
  load,
  getEntries,
  MAX_INPUT_HISTORY,
};
