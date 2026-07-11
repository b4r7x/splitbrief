import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../schemas/session.js';
import type { SessionRef } from '../types/session-ref.js';
import type { WorkflowState } from '../schemas/workflow.js';
import type { Config } from '../schemas/config.js';
import { SessionSchema } from '../schemas/session.js';
import { parsePersistedSession } from './summary-parser.js';
import { sessionDir, sessionsRoot, isValidSessionId } from '../paths.js';
import { warnError, warnStderr } from '../../lib/warn.js';
import { isENOENT } from '../../lib/process/errors.js';
import { loadState } from '../state/persistence.js';
import { sessionError } from './errors.js';
import { writeSecureFile } from '../../lib/fs.js';
import { TRANSCRIPT_OMITTED_FEATURE, isOpaqueSessionId } from './lifecycle.js';
import { readSessionLockfileData } from './lockfile-status.js';

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

function recoveredFeature(projectDir: string, sessionId: string, state: WorkflowState): string {
  const lockfile = readSessionLockfileData({ sessionDir: sessionDir(projectDir, sessionId) });
  if (lockfile.kind === 'valid' && lockfile.data.feature === TRANSCRIPT_OMITTED_FEATURE) {
    return TRANSCRIPT_OMITTED_FEATURE;
  }
  return isOpaqueSessionId(sessionId) ? TRANSCRIPT_OMITTED_FEATURE : state.feature;
}

function stateToSession(projectDir: string, sessionId: string, state: WorkflowState): Session {
  const startedAt = Date.parse(state.startedAt);
  return {
    id: sessionId,
    feature: recoveredFeature(projectDir, sessionId, state),
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
  return stateToSession(projectDir, sessionId, state);
}

export function readSessionPersistTranscript(ref: SessionRef): boolean {
  const { projectDir, sessionId } = ref;
  if (isOpaqueSessionId(sessionId)) return false;

  const sessDir = sessionDir(projectDir, sessionId);
  const summary = readSummaryFile(join(sessDir, 'summary.json'), sessionId);
  if (summary?.feature === TRANSCRIPT_OMITTED_FEATURE) return false;

  const lockfile = readSessionLockfileData({ sessionDir: sessDir });
  if (lockfile.kind === 'valid' && lockfile.data.feature === TRANSCRIPT_OMITTED_FEATURE) {
    return false;
  }

  return true;
}

export function configForSessionTranscriptPolicy(
  config: Config,
  ref: SessionRef | undefined,
): Config {
  if (!ref) return config;
  const persistTranscript = config.workflow.persistTranscript && readSessionPersistTranscript(ref);
  if (persistTranscript === config.workflow.persistTranscript) return config;
  return { ...config, workflow: { ...config.workflow, persistTranscript } };
}

// Home windows the list by terminal fit and the palette caps session items to 10, so 30 is a safe upper bound.
const MAX_RECENT_SESSIONS = 30;

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
  return { sessions: all.slice(0, MAX_RECENT_SESSIONS), total: all.length };
}

export function listSessions(projectDir: string): Session[] {
  return listRecentSessions(projectDir).sessions;
}

export function listAllSessions(projectDir: string): Session[] {
  return readSessions(projectDir);
}
