import { createStore, storeBase } from './create-store.js';
import { getSessionDir, listSessions } from '../utils/sessions.js';
import type { Session } from '../types.js';

interface SessionsState {
  sessions: Session[];
}

const store = createStore<SessionsState>({ sessions: [] });

function load(scope: 'project' | 'global', projectDir: string) {
  store.set({ sessions: listSessions(getSessionDir(scope, projectDir)) });
}

export const sessionsStore = { ...storeBase(store), load };
