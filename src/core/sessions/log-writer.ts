import { join, resolve } from 'node:path';
import type { z } from 'zod';
import {
  SessionLogEntrySchema,
  SessionLogEventEntrySchema,
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
import { toErrorMessage } from '../../utils/format-errors.js';
import { nowIso } from '../../utils/format-time.js';
import { protectConsumerPayload } from '../consumer-policy.js';
import { assertSessionDirConfined } from './confinement.js';

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
      const line = JSON.stringify(parsed.data) + '\n';
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
      warnStderr(`Warning: failed to persist log entry: ${toErrorMessage(err)}`);
    }
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
  opts: { persistTranscript: boolean },
): void {
  if (!opts.persistTranscript) return;
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

export function appendProtectedEngineEvent<TEvent extends { type: string; ts: number }>(
  ref: SessionRef,
  event: TEvent,
  schema: z.ZodType<TEvent>,
): void {
  const protectedEvent = protectConsumerPayload({ context: 'session-log', payload: event });
  if (protectedEvent.oversized) return;

  const parsedEvent = schema.safeParse(protectedEvent.payload);
  if (!parsedEvent.success) return;

  const protectedEntry = protectConsumerPayload({
    context: 'session-log',
    payload: toEngineEventEntry(parsedEvent.data),
  });
  if (protectedEntry.oversized) return;

  const parsedEntry = SessionLogEventEntrySchema.safeParse(protectedEntry.payload);
  if (!parsedEntry.success) return;

  appendLine(ref, parsedEntry.data);
}
