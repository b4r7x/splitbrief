import { createStore, storeBase } from './create-store.js';
import { getSessionDir, listSessions, listAllSessions } from '../core/sessions/io.js';
import type { Session } from '../types.js';

interface SessionsState {
  sessions: Session[];
  allSessions: Session[];
}

const store = createStore<SessionsState>({ sessions: [], allSessions: [] });

function load(scope: 'project' | 'global', projectDir: string) {
  store.set(s => ({ ...s, sessions: listSessions(getSessionDir(scope, projectDir)) }));
}

function loadAll(scope: 'project' | 'global', projectDir: string) {
  store.set(s => ({ ...s, allSessions: listAllSessions(getSessionDir(scope, projectDir)) }));
}

export const sessionsStore = { ...storeBase(store), load, loadAll };
