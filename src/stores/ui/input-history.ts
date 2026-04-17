import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStore, storeBase } from '../create-store.js';
import { writeSecureFile } from '../../utils/fs.js';
import { DIPTYCH_DIR } from '../../core/paths.js';
import { warnError } from '../../utils/warn.js';

interface InputHistoryState {
  entries: string[];
}

const MAX_INPUT_HISTORY = 10;
const HISTORY_FILE = join(homedir(), DIPTYCH_DIR, 'history');

const initial: InputHistoryState = { entries: [] };

const store = createStore<InputHistoryState>(initial);

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function save(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const { entries } = store.get();
      writeSecureFile(HISTORY_FILE, entries.join('\n'));
    } catch (err) {
      warnError('input-history: failed to save', err);
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
    store.set({ entries });
  } catch {
    // Missing file is fine — start with empty history
  }
}

function push(value: string): void {
  const trimmed = value.trim();
  if (!trimmed) return;

  store.set(state => {
    if (state.entries[0] === trimmed) return state;
    return {
      entries: [trimmed, ...state.entries.filter(entry => entry !== trimmed)].slice(0, MAX_INPUT_HISTORY),
    };
  });

  save();
}

export const inputHistoryStore = {
  ...storeBase(store),
  push,
  load,
};
