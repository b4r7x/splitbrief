import { readdirSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Session } from '../schemas/session.js';
import { SessionSchema } from '../schemas/session.js';
import { DIPTYCH_DIR, SESSIONS_DIR, sessionDir, sessionsRoot, getDiptychPath } from '../paths.js';
import { warnError, warnStderr } from '../../lib/warn.js';
import { isENOENT } from '../../lib/process/errors.js';
import { sessionError } from './errors.js';

export function getSessionDir(scope: 'project' | 'global', projectDir: string): string {
  if (scope === 'global') {
    return join(homedir(), DIPTYCH_DIR, SESSIONS_DIR);
  }
  return getDiptychPath(projectDir, SESSIONS_DIR);
}

function readSummaryFile(filePath: string): Session | null {
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

export function saveSummary(projectDir: string, id: string, session: Session): void {
  const result = SessionSchema.safeParse(session);
  if (!result.success) {
    throw sessionError.invalidData(id, result.error.message);
  }
  const dir = sessionDir(projectDir, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, 'summary.json');
  writeFileSync(filePath, JSON.stringify(session, null, 2) + '\n');
  chmodSync(filePath, 0o600);
}

const MAX_RECENT_SESSIONS = 10;

function readSessions(projectDir: string): Session[] {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true });
  const sessions: Session[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const summaryPath = join(root, entry.name, 'summary.json');
    const session = readSummaryFile(summaryPath);
    if (session) sessions.push(session);
  }

  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}

export function listSessions(projectDir: string): Session[] {
  return readSessions(projectDir).slice(0, MAX_RECENT_SESSIONS);
}

export function listAllSessions(projectDir: string): Session[] {
  return readSessions(projectDir);
}
