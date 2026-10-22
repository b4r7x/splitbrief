import { createStore, storeBase } from '../create-store.js';
import { listSessions } from '../../core/sessions/io.js';
import type { Session } from '../../core/schemas/session.js';

interface SessionsState {
  sessions: Session[];
  totalCount: number;
  /** The project the list was read from, so a run that just ended can refresh it. */
  projectDir: string | null;
}

const initial: SessionsState = { sessions: [], totalCount: 0, projectDir: null };

const store = createStore<SessionsState>(initial);

function load(projectDir: string) {
  const sessions = listSessions(projectDir);
  const current = store.get();
  // A listing returns the same row for a run that did not change, so an unchanged list paints nothing.
  if (
    current.projectDir === projectDir &&
    current.sessions.length === sessions.length &&
    sessions.every((row, index) => row === current.sessions[index])
  ) {
    return;
  }
  store.set({ sessions, totalCount: sessions.length, projectDir });
}

function refresh() {
  const { projectDir } = store.get();
  if (projectDir !== null) load(projectDir);
}

function __testReset(next?: Partial<SessionsState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

export const sessionsStore = { ...storeBase(store), load, refresh, __testReset };
