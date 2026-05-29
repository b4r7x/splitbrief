import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../schemas/session.js';
import type { SessionRef } from '../types/session-ref.js';
import { SessionSchema } from '../schemas/session.js';
import { sessionDir, sessionsRoot } from '../paths.js';
import { warnError, warnStderr } from '../../lib/warn.js';
import { isENOENT } from '../../lib/process/errors.js';
import { sessionError } from './errors.js';
import { writeSecureFile } from '../../lib/fs.js';

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

export function saveSummary(ref: SessionRef, session: Session): void {
  const { projectDir, sessionId: id } = ref;
  const result = SessionSchema.safeParse(session);
  if (!result.success) {
    throw sessionError.invalidData(id, result.error.message);
  }
  if (result.data.id !== id) {
    throw sessionError.idMismatch(id, result.data.id);
  }
  writeSecureFile(
    join(sessionDir(projectDir, id), 'summary.json'),
    `${JSON.stringify(session, null, 2)}\n`,
  );
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
