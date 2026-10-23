import { join, resolve } from 'node:path';
import {
  SessionLogEntrySchema,
  SESSION_LOG_MAX_ENTRY_BYTES,
  type SessionLogEventEntry,
  type SessionLogMessageEntry,
} from '../schemas/session-log.js';
import { PhaseSchema } from '../schemas/enums.js';
import { TaskIdSchema } from '../schemas/task.js';
import type { SessionRef } from '../types/session-ref.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR, SESSION_LOG_FILE } from '../paths.js';
import { fsError, rejectSymlinkTarget } from '../../lib/fs.js';
import { confinedAppendFileSync, confinedEnsureDir } from '../../lib/confined-fs.js';
import { warnStderr } from '../../lib/warn.js';
import { nowIso } from '../../utils/format-time.js';
import { boundSessionLogString } from '../payload-bounds.js';
import { assertSessionDirConfined } from './confinement.js';
import { sessionFileFailure } from './errors.js';

export type SessionLogAppender = (entry: SessionLogMessageEntry | SessionLogEventEntry) => void;

export type SessionLogAppendFailure =
  | 'invalid-entry'
  | 'oversized-entry'
  | 'symlink-write'
  | 'write-failed';

export function createSessionLogAppender(
  ref: SessionRef,
  opts: { onFailure?: ((failure: SessionLogAppendFailure) => void) | undefined } = {},
): SessionLogAppender {
  const sessionRel = join(SPLITBRIEF_DIR, SESSIONS_DIR, ref.sessionId);
  const logRel = join(sessionRel, SESSION_LOG_FILE);
  const logFile = resolve(ref.projectDir, logRel);
  let ensured = false;
  return (entry) => {
    try {
      if (!ensured) {
        assertSessionDirConfined(ref.projectDir, ref.sessionId);
        confinedEnsureDir(ref.projectDir, sessionRel);
        ensured = true;
      }
      const parsed = SessionLogEntrySchema.safeParse(entry);
      if (!parsed.success) {
        opts.onFailure?.('invalid-entry');
        warnStderr('Warning: failed to persist invalid log entry');
        return;
      }
      const logged =
        parsed.data.kind === 'message' && parsed.data.role === 'user'
          ? boundUserMessage(parsed.data)
          : parsed.data;
      const line = JSON.stringify(logged) + '\n';
      if (Buffer.byteLength(line, 'utf8') > SESSION_LOG_MAX_ENTRY_BYTES) {
        opts.onFailure?.('oversized-entry');
        warnStderr(
          `Warning: failed to persist oversized log entry exceeding ${SESSION_LOG_MAX_ENTRY_BYTES} bytes`,
        );
        return;
      }
      rejectSymlinkTarget(logFile);
      confinedAppendFileSync(ref.projectDir, logRel, line);
    } catch (err) {
      if (fsError.isSymlinkWrite(err)) {
        opts.onFailure?.('symlink-write');
        throw err;
      }
      opts.onFailure?.('write-failed');
      warnStderr(`Warning: ${sessionFileFailure('Could not save the run log', logRel, err)}`);
    }
  };
}

/** Bounded the way the session-log sink bounds the message's event, so the two pair on replay. */
function boundUserMessage(entry: SessionLogMessageEntry): SessionLogMessageEntry {
  return {
    ...entry,
    text: boundSessionLogString(entry.text),
    ...(entry.qa !== undefined && {
      qa: entry.qa.map((pair) => ({
        question: boundSessionLogString(pair.question),
        answer: boundSessionLogString(pair.answer),
      })),
    }),
  };
}

function appendLine(ref: SessionRef, entry: SessionLogMessageEntry | SessionLogEventEntry): void {
  createSessionLogAppender(ref)(entry);
}

export function toEngineEventEntry<TEvent extends { type: string; ts: number }>(
  event: TEvent,
): SessionLogEventEntry {
  const { type, ts, ...rest } = event;
  const data: Record<string, unknown> = { ...rest };
  const phase = PhaseSchema.safeParse(data['phase']);
  const taskId = TaskIdSchema.safeParse(data['taskId']);
  delete data['phase'];
  delete data['taskId'];
  return {
    kind: 'event',
    ts: new Date(ts).toISOString(),
    type,
    ...(phase.success && { phase: phase.data }),
    ...(taskId.success && { taskId: taskId.data }),
    data,
  };
}

export function appendMessage(
  ref: SessionRef,
  message: Omit<SessionLogMessageEntry, 'ts' | 'kind'>,
): void {
  const entry: SessionLogMessageEntry = {
    kind: 'message',
    ts: nowIso(),
    ...message,
  };
  appendLine(ref, entry);
}

export function appendEngineEvent<TEvent extends { type: string; ts: number }>(
  ref: SessionRef,
  event: TEvent,
): void {
  appendLine(ref, toEngineEventEntry(event));
}
