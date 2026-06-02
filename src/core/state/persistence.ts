import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState } from '../schemas/workflow.js';
import type { SessionLogEventEntry, SessionLogMessageEntry } from '../schemas/session-log.js';
import { PhaseSchema } from '../schemas/enums.js';
import { TaskIdSchema } from '../schemas/task.js';
import { WorkflowStateSchema } from '../schemas/workflow.js';
import { CURRENT_STATE_VERSION } from './machine.js';
import type { SessionRef } from '../types/session-ref.js';
import { STATE_FILE, SESSION_LOG_FILE, sessionDir } from '../paths.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { ensureSecureDir, writeSecureFile, SECURE_FILE_MODE } from '../../lib/fs.js';
import { warnStderr } from '../../lib/warn.js';
import { toErrorMessage } from '../../utils/format-errors.js';

export function saveState(ref: SessionRef, state: WorkflowState): void {
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  writeSecureFile(join(dir, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}

export function loadState(ref: SessionRef): WorkflowState | null {
  const filePath = join(sessionDir(ref.projectDir, ref.sessionId), STATE_FILE);
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

const ensuredDirs = new Set<string>();

function appendLine(ref: SessionRef, entry: SessionLogMessageEntry | SessionLogEventEntry): void {
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  try {
    if (!ensuredDirs.has(dir)) {
      ensureSecureDir(dir);
      ensuredDirs.add(dir);
    }
    appendFileSync(join(dir, SESSION_LOG_FILE), JSON.stringify(entry) + '\n', {
      mode: SECURE_FILE_MODE,
    });
  } catch (err) {
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
