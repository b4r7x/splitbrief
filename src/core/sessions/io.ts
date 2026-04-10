import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Session } from '../types/index.js';
import { SessionSchema } from '../types/schemas/index.js';
import { TINY_SPEC_DIR, SESSIONS_DIR } from '../paths.js';
import { warnError, warnStderr } from '../../utils/format.js';
import { isENOENT } from '../../utils/process-errors.js';

export function getSessionDir(scope: 'project' | 'global', projectDir: string): string {
  if (scope === 'global') {
    return join(homedir(), TINY_SPEC_DIR, SESSIONS_DIR);
  }
  return join(projectDir, TINY_SPEC_DIR, SESSIONS_DIR);
}

function readSession(filePath: string): Session | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const result = SessionSchema.safeParse(parsed);
    if (!result.success) {
      warnStderr(`Warning: invalid session ${filePath}: ${result.error.message}`);
      return null;
    }
    return result.data;
  } catch (err) {
    if (!isENOENT(err)) {
      warnError(`Failed to read session ${filePath}`, err);
    }
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

