import { readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import type { WorkflowState } from '../schemas/workflow.js';
import type { SessionLogEventEntry, SessionLogMessageEntry } from '../schemas/session-log.js';
import { PhaseSchema } from '../schemas/enums.js';
import { TaskIdSchema } from '../schemas/task.js';
import { WorkflowStateSchema } from '../schemas/workflow.js';
import { CURRENT_STATE_VERSION } from './machine.js';
import type { SessionRef } from '../types/session-ref.js';
import {
  DIPTYCH_DIR,
  SESSIONS_DIR,
  STATE_FILE,
  SESSION_LOG_FILE,
  sessionDir,
  validateSessionId,
} from '../paths.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { fsError } from '../../lib/fs.js';
import {
  confinedAppendFileSync,
  confinedEnsureDir,
  confinedWriteFile,
} from '../../lib/confined-fs.js';
import {
  assertExistingPathConfined,
  assertPathConfined,
  pathConfinementError,
} from '../../lib/path-confinement.js';
import { warnStderr } from '../../lib/warn.js';
import { toErrorMessage } from '../../utils/format-errors.js';

function rejectSymlinkTarget(filePath: string): void {
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      throw fsError.symlinkWrite(filePath);
    }
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
  }
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (true) {
    try {
      return realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function assertInsideRoot(projectDir: string, fullPath: string): void {
  const realRoot = nearestExistingAncestor(projectDir);
  const realTarget = nearestExistingAncestor(fullPath);
  const rel = relative(realRoot, realTarget);
  if (!(rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))) {
    throw pathConfinementError.escapesRoot(relative(projectDir, fullPath));
  }
}

function assertSessionDirConfined(projectDir: string, sessionId: string): void {
  validateSessionId(sessionId);
  const sessionRel = join(DIPTYCH_DIR, SESSIONS_DIR, sessionId);
  assertPathConfined(sessionRel, projectDir);
  assertInsideRoot(projectDir, resolve(projectDir, sessionRel));
}

export function saveState(ref: SessionRef, state: WorkflowState): void {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  confinedWriteFile(
    ref.projectDir,
    join(DIPTYCH_DIR, SESSIONS_DIR, ref.sessionId, STATE_FILE),
    JSON.stringify(state, null, 2) + '\n',
  );
}

export function loadState(ref: SessionRef): WorkflowState | null {
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  const filePath = join(dir, STATE_FILE);
  if (!existsSync(filePath)) return null;
  try {
    rejectSymlinkTarget(filePath);
  } catch {
    warnStderr('Warning: refusing to read state through symlink, ignoring');
    return null;
  }
  assertExistingPathConfined(
    `${DIPTYCH_DIR}/${SESSIONS_DIR}/${ref.sessionId}/${STATE_FILE}`,
    ref.projectDir,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    warnStderr('Warning: corrupt state file, ignoring');
    return null;
  }
  const record = narrowRecord(raw);
  if (!record) return null;
  if (record.stateVersion !== CURRENT_STATE_VERSION) return null;
  const result = WorkflowStateSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data;
}

function appendLine(ref: SessionRef, entry: SessionLogMessageEntry | SessionLogEventEntry): void {
  const logRel = join(DIPTYCH_DIR, SESSIONS_DIR, ref.sessionId, SESSION_LOG_FILE);
  const logFile = resolve(ref.projectDir, logRel);
  try {
    assertSessionDirConfined(ref.projectDir, ref.sessionId);
    confinedEnsureDir(ref.projectDir, join(DIPTYCH_DIR, SESSIONS_DIR, ref.sessionId));
    rejectSymlinkTarget(logFile);
    confinedAppendFileSync(ref.projectDir, logRel, JSON.stringify(entry) + '\n');
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
    warnStderr(`Warning: failed to persist log entry: ${toErrorMessage(err)}`);
  }
}

export function appendMessage(
  ref: SessionRef,
  message: Omit<SessionLogMessageEntry, 'ts' | 'kind'>,
  persistTranscript: boolean,
): void {
  if (!persistTranscript) return;
  const entry: SessionLogMessageEntry = {
    kind: 'message',
    ts: new Date().toISOString(),
    ...message,
  };
  appendLine(ref, entry);
}

export function appendEngineEvent<TEvent extends { type: string; ts: number }>(
  ref: SessionRef,
  event: TEvent,
): void {
  const { type, ts, ...rest } = event;
  const data: Record<string, unknown> = { ...rest };
  const phase = PhaseSchema.safeParse(data['phase']);
  const taskId = TaskIdSchema.safeParse(data['taskId']);
  delete data['phase'];
  delete data['taskId'];
  const entry = {
    kind: 'event' as const,
    ts: new Date(ts).toISOString(),
    type,
    ...(phase.success && { phase: phase.data }),
    ...(taskId.success && { taskId: taskId.data }),
    data,
  };
  appendLine(ref, entry);
}
