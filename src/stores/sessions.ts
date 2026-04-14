import { createStore, storeBase } from './create-store.js';
import { listSessions, listAllSessions } from '../core/sessions/io.js';
import type { Session } from '../types.js';

interface SessionsState {
  sessions: Session[];
  allSessions: Session[];
}

const store = createStore<SessionsState>({ sessions: [], allSessions: [] });

function load(projectDir: string) {
  store.set(s => ({ ...s, sessions: listSessions(projectDir) }));
}

function loadAll(projectDir: string) {
  store.set(s => ({ ...s, allSessions: listAllSessions(projectDir) }));
}

export const sessionsStore = { ...storeBase(store), load, loadAll };
