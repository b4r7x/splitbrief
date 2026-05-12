import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../schemas/workflow.js';
import type { SessionLogEventEntry, SessionLogMessageEntry } from '../schemas/session-log.js';
import type { Phase } from '../schemas/enums.js';
import type { TaskId } from '../schemas/task.js';
import { WorkflowStateSchema } from '../schemas/workflow.js';
import { CURRENT_STATE_VERSION } from './machine.js';
import { STATE_FILE, SESSION_LOG_FILE, sessionDir } from '../paths.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { ensureSecureDir, writeSecureFile, SECURE_FILE_MODE } from '../../lib/fs.js';
import { warnStderr } from '../../lib/warn.js';
import { toErrorMessage } from '../../utils/format-errors.js';

export function saveState(projectDir: string, sessionId: string, state: WorkflowState): void {
  const dir = sessionDir(projectDir, sessionId);
  writeSecureFile(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

export function loadState(projectDir: string, sessionId: string): WorkflowState | null {
  const filePath = join(sessionDir(projectDir, sessionId), STATE_FILE);
  if (!existsSync(filePath)) return null;
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

function appendLine(
  projectDir: string,
  sessionId: string,
  entry: SessionLogMessageEntry | SessionLogEventEntry,
): void {
  const dir = sessionDir(projectDir, sessionId);
  try {
    ensureSecureDir(dir);
    appendFileSync(join(dir, SESSION_LOG_FILE), JSON.stringify(entry) + '\n', { mode: SECURE_FILE_MODE });
  } catch (err) {
    warnStderr(`Warning: failed to persist log entry: ${toErrorMessage(err)}`);
  }
}

export function appendMessage(
  projectDir: string,
  sessionId: string,
  message: Omit<SessionLogMessageEntry, 'ts' | 'kind'>,
  persistTranscript: boolean,
): void {
  if (!persistTranscript) return;
  const entry: SessionLogMessageEntry = { kind: 'message', ts: new Date().toISOString(), ...message };
  appendLine(projectDir, sessionId, entry);
}

export function appendEngineEvent<TEvent extends { type: string; ts: number }>(
  projectDir: string,
  sessionId: string,
  event: TEvent & { phase?: Phase; taskId?: TaskId },
): void {
  const { type, ts, phase, taskId, ...data } = event;
  const entry = {
    kind: 'event' as const,
    ts: new Date(ts).toISOString(),
    type,
    ...(phase !== undefined && { phase }),
    ...(taskId !== undefined && { taskId }),
    data,
  };
  appendLine(projectDir, sessionId, entry);
}
