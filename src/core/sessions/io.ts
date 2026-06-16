import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../schemas/session.js';
import type { SessionRef } from '../types/session-ref.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { SessionSchema } from '../schemas/session.js';
import { parsePersistedSession } from './summary-parser.js';
import { sessionDir, sessionsRoot, validateSessionId } from '../paths.js';
import { warnError, warnStderr } from '../../lib/warn.js';
import { isENOENT } from '../../lib/process/errors.js';
import { loadState } from '../state/persistence.js';
import { sessionError } from './errors.js';
import { writeSecureFile } from '../../lib/fs.js';

function readSummaryFile(filePath: string, sessionId: string): Session | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const result = parsePersistedSession(parsed);
    if (result.status === 'invalid') {
      warnStderr(`Warning: invalid session ${filePath}: ${result.error}`);
      return null;
    }
    if (result.session.id !== sessionId) {
      warnStderr(
        `Warning: session ${filePath} payload id '${result.session.id}' does not match directory '${sessionId}'; using directory id`,
      );
      return { ...result.session, id: sessionId };
    }
    return result.session;
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

function stateToSession(sessionId: string, state: WorkflowState): Session {
  const startedAt = Date.parse(state.startedAt);
  return {
    id: sessionId,
    feature: state.feature,
    startedAt: Number.isNaN(startedAt) ? 0 : startedAt,
    completedAt: null,
    stateVersion: state.stateVersion,
    status: 'interrupted',
    summary: null,
  };
}

function recoverSession(projectDir: string, sessionId: string): Session | null {
  const state = loadState({ projectDir, sessionId });
  if (!state) return null;
  return stateToSession(sessionId, state);
}

// Home windows the list by terminal fit and the palette caps session items to 10, so 30 is a safe upper bound.
const MAX_RECENT_SESSIONS = 30;

function isValidSessionDirectory(sessionId: string): boolean {
  try {
    validateSessionId(sessionId);
    return true;
  } catch (err) {
    warnError(`Skipping session directory '${sessionId}'`, err);
    return false;
  }
}

function readSessions(projectDir: string): Session[] {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true });
  const sessions: Session[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isValidSessionDirectory(entry.name)) continue;
    const summaryPath = join(root, entry.name, 'summary.json');
    const session =
      readSummaryFile(summaryPath, entry.name) ?? recoverSession(projectDir, entry.name);
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
