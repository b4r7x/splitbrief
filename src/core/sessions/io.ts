import { readdirSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Session } from '../types/index.js';
import { SessionSchema } from '../types/schemas/index.js';
import { TINY_SPEC_DIR, SESSIONS_DIR } from '../paths.js';
import { validateSafeIdentifier } from '../../utils/fs.js';
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

function validateSessionId(id: string): void {
  validateSafeIdentifier(id, 'session id');
}

export function saveSession(dir: string, session: Session): void {
  validateSessionId(session.id);
  const result = SessionSchema.safeParse(session);
  if (!result.success) {
    throw new Error(`Invalid session data: ${result.error.message}`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${session.id}.json`);
  writeFileSync(filePath, JSON.stringify(session, null, 2) + '\n');
  chmodSync(filePath, 0o600);
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

