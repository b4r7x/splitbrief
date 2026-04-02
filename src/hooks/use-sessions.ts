import { useMemo } from 'react';
import { getSessionDir, listSessions } from '../utils/sessions.js';

export function useSessions(sessionsScope: 'project' | 'global', projectDir: string) {
  const sessions = useMemo(() => {
    const dir = getSessionDir(sessionsScope, projectDir);
    return listSessions(dir);
  }, [sessionsScope, projectDir]);

  return { sessions };
}
