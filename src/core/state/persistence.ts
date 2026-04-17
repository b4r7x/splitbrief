import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../types/state-actions.js';
import type { OrchestratorEvent, OrchestratorEventType, SessionLogEventEntry, SessionLogEventEntryFor, SessionLogMessageEntry } from '../types/orchestrator-events.js';
import { WorkflowStateSchema } from '../types/schemas/workflow.js';
import { CURRENT_STATE_VERSION } from './machine.js';
import { STATE_FILE, SESSION_LOG_FILE, sessionDir } from '../paths.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { ensureSecureDir, writeSecureFile, SECURE_FILE_MODE } from '../../utils/fs.js';
import { warnStderr } from '../../utils/warn.js';
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

function appendLine(projectDir: string, sessionId: string, entry: SessionLogMessageEntry): void;
function appendLine<T extends OrchestratorEventType>(projectDir: string, sessionId: string, entry: SessionLogEventEntryFor<T>): void;
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

function toSessionLogEventEntry<T extends OrchestratorEventType>(
  event: OrchestratorEvent<T>,
): SessionLogEventEntryFor<T> {
  return {
    kind: 'event',
    ts: new Date(event.ts).toISOString(),
    type: event.type,
    phase: event.phase,
    data: event.data,
    ...(event.taskId ? { taskId: event.taskId } : {}),
  };
}

export function appendEvent<T extends OrchestratorEventType>(projectDir: string, sessionId: string, event: OrchestratorEvent<T>): void {
  appendLine(projectDir, sessionId, toSessionLogEventEntry(event));
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
