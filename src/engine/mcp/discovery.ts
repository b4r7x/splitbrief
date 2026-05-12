import { existsSync } from 'node:fs';
import { sessionDir } from '../../core/paths.js';
import { listAllSessions } from '../../core/sessions/io.js';
import { readActive } from '../../core/sessions/lifecycle.js';
import { error } from '../../utils/error.js';

export const mcpDiscoveryError = {
  sessionNotFound: (sessionId: string) => error('mcp-session-not-found', `Session not found: ${sessionId}`, { sessionId }),
  noSessions: () => error('mcp-no-sessions', 'No sessions found in this project.'),
  noActiveSession: () => error('mcp-no-active-session', 'No active session. Use --session <id> or --all-sessions.'),
} as const;

export type SessionDiscoveryOpts = {
  session?: string;
  allSessions?: boolean;
};

export function resolveSessionIds(projectDir: string, opts: SessionDiscoveryOpts): string[] {
  if (opts.session !== undefined) {
    const dir = sessionDir(projectDir, opts.session);
    if (!existsSync(dir)) {
      throw mcpDiscoveryError.sessionNotFound(opts.session);
    }
    return [opts.session];
  }

  if (opts.allSessions) {
    const sessions = listAllSessions(projectDir);
    if (sessions.length === 0) {
      throw mcpDiscoveryError.noSessions();
    }
    return sessions.map((s) => s.id);
  }

  const activeId = readActive(projectDir);
  if (!activeId) {
    throw mcpDiscoveryError.noActiveSession();
  }
  return [activeId];
}
