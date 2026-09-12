import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../schemas/session.js';
import type { SessionRef } from '../types/session-ref.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { SessionSchema } from '../schemas/session.js';
import { parsePersistedSession } from './summary-parser.js';
import { sessionDir, sessionsRoot, isValidSessionId } from '../paths.js';
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

export function readSession(ref: SessionRef): Session | null {
  const { projectDir, sessionId } = ref;
  return readSummaryFile(join(sessionDir(projectDir, sessionId), 'summary.json'), sessionId);
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

function isValidSessionDirectory(sessionId: string): boolean {
  if (!isValidSessionId(sessionId)) {
    warnError(`Skipping session directory '${sessionId}'`, sessionError.invalidId(sessionId));
    return false;
  }
  return true;
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

export function listRecentSessions(projectDir: string): { sessions: Session[]; total: number } {
  const all = readSessions(projectDir);
  return { sessions: all, total: all.length };
}

export function listSessions(projectDir: string): Session[] {
  return listRecentSessions(projectDir).sessions;
}

export function listAllSessions(projectDir: string): Session[] {
  return readSessions(projectDir);
}
