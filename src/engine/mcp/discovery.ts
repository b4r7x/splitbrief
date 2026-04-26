import { existsSync } from 'node:fs';
import { sessionDir } from '../../core/paths.js';
import { listAllSessions } from '../../core/sessions/io.js';
import { readActive } from '../../core/sessions/lifecycle.js';

export type SessionDiscoveryOpts = {
  session?: string;
  allSessions?: boolean;
};

export function resolveSessionIds(projectDir: string, opts: SessionDiscoveryOpts): string[] {
  if (opts.session !== undefined) {
    const dir = sessionDir(projectDir, opts.session);
    if (!existsSync(dir)) {
      throw new Error(`Session not found: ${opts.session}`);
    }
    return [opts.session];
  }

  if (opts.allSessions) {
    const sessions = listAllSessions(projectDir);
    if (sessions.length === 0) {
      throw new Error('No sessions found in this project.');
    }
    return sessions.map((s) => s.id);
  }

  const activeId = readActive(projectDir);
  if (!activeId) {
    throw new Error('No active session. Use --session <id> or --all-sessions.');
  }
  return [activeId];
}
