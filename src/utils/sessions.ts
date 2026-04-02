import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Session } from '../types.js';

export function getSessionDir(scope: 'project' | 'global', projectDir: string): string {
  if (scope === 'global') {
    return join(homedir(), '.tiny-spec', 'sessions');
  }
  return join(projectDir, '.tiny-spec', 'sessions');
}

function readSession(filePath: string): Session | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

const MAX_RECENT_SESSIONS = 10;

export function listSessions(dir: string): Session[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const sessions: Session[] = [];

  for (const file of files) {
    const session = readSession(join(dir, file));
    if (session) sessions.push(session);
  }

  return sessions
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_RECENT_SESSIONS);
}

