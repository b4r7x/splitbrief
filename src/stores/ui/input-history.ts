import { createStore, storeBase } from '../create-store.js';
import type { Screen } from '../../core/navigation/types.js';

export interface InputHistoryState {
  entries: string[];
  workflowEntries: string[];
}

export const MAX_INPUT_HISTORY = 50;

const initial: InputHistoryState = { entries: [], workflowEntries: [] };

const store = createStore<InputHistoryState>(initial);

export interface InputHistorySubmissionOptions {
  currentScreen: Screen;
  persistTranscript: boolean;
}

export interface InputHistoryEntriesOptions {
  currentScreen: Screen;
  persistTranscript: boolean;
}

export function normalizeInputHistoryEntries(entries: readonly string[]): string[] {
  const deduped: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (deduped.includes(trimmed)) continue;
    deduped.push(trimmed);
    if (deduped.length >= MAX_INPUT_HISTORY) break;
  }
  return deduped;
}

function putEntry(entries: readonly string[], value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (entries[0] === trimmed) return null;
  return [trimmed, ...entries.filter((entry) => entry !== trimmed)].slice(0, MAX_INPUT_HISTORY);
}

function shouldPersistSubmission(
  value: string,
  { currentScreen, persistTranscript }: InputHistorySubmissionOptions,
): boolean {
  return currentScreen === 'home' || value.startsWith('/') || persistTranscript;
}

function push(value: string): void {
  store.set((state) => {
    const entries = putEntry(state.entries, value);
    return entries === null ? state : { ...state, entries };
  });
}

function pushSubmission(value: string, opts: InputHistorySubmissionOptions): void {
  const trimmed = value.trim();
  if (!trimmed) return;

  store.set((state) => {
    const entries = shouldPersistSubmission(trimmed, opts)
      ? (putEntry(state.entries, trimmed) ?? state.entries)
      : state.entries;
    const workflowEntries =
      opts.currentScreen === 'home'
        ? state.workflowEntries
        : (putEntry(state.workflowEntries, trimmed) ?? state.workflowEntries);

    if (entries === state.entries && workflowEntries === state.workflowEntries) return state;
    return { entries, workflowEntries };
  });
}

function hydrate(entries: string[]): void {
  store.set({
    entries: normalizeInputHistoryEntries(entries),
    workflowEntries: [],
  });
}

function isSlashCommand(entry: string): boolean {
  return entry.startsWith('/');
}

export function getInputHistoryEntries(
  state: InputHistoryState,
  opts: InputHistoryEntriesOptions,
): string[] {
  if (opts.currentScreen === 'home') return state.entries;
  const persistedEntries = opts.persistTranscript
    ? state.entries
    : state.entries.filter(isSlashCommand);
  return normalizeInputHistoryEntries([...state.workflowEntries, ...persistedEntries]);
}

export const inputHistoryStore = {
  ...storeBase(store),
  push,
  pushSubmission,
  hydrate,
};
