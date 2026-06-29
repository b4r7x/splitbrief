import { createStore, storeBase } from '../create-store.js';
import { listRecentSessions, listAllSessions } from '../../core/sessions/io.js';
import type { Session } from '../../core/schemas/session.js';

interface SessionsState {
  sessions: Session[];
  allSessions: Session[];
  totalCount: number;
}

const initial: SessionsState = { sessions: [], allSessions: [], totalCount: 0 };

const store = createStore<SessionsState>(initial);

function load(projectDir: string) {
  const { sessions, total } = listRecentSessions(projectDir);
  store.set((s) => ({ ...s, sessions, totalCount: total }));
}

function loadAll(projectDir: string) {
  store.set((s) => ({ ...s, allSessions: listAllSessions(projectDir) }));
}

export const sessionsStore = { ...storeBase(store), load, loadAll };
