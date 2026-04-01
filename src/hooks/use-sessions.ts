import { useState, useEffect } from 'react';
import type { Session } from '../types.js';
import { getSessionDir, listSessions, writeSession } from '../utils/sessions.js';

export function useSessions(sessionsScope: 'project' | 'global', projectDir: string) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const dir = getSessionDir(sessionsScope, projectDir);
    setSessions(listSessions(dir));
    setLoading(false);
  }, [sessionsScope, projectDir]);

  const saveSession = (session: Session) => {
    const dir = getSessionDir(sessionsScope, projectDir);
    writeSession(dir, session);
    setSessions(listSessions(dir));
  };

  return { sessions, saveSession, loading };
}
