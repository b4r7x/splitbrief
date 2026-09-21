import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import {
  SESSION_LOG_MAX_ENTRY_BYTES,
  SessionLogEntrySchema,
} from '../../../core/schemas/session-log.js';
import type { CallUsageEvidence } from '../../../core/schemas/usage-evidence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { forEachLineSync, parseJsonlLine } from '../../../lib/fs.js';
import { engineEventFromLogEntry } from '../../events/replay.js';
import type { EngineEvent, EventSink } from '../../events/types.js';
import { collectCallUsageEvidence } from './call-usage.js';

/**
 * The records a call's usage evidence is folded from. Every `runner_call_*`
 * event carries the same call context, so the four that also carry usage carry
 * the whole attribution too; the rest — activity, deltas, tool use — are stream
 * noise here and are never kept.
 */
const USAGE_EVIDENCE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'runner_call_started',
  'runner_call_usage',
  'runner_call_completed',
  'runner_call_error',
]);

const liveRunCalls = new Map<string, EngineEvent[]>();

// A session's own directory is its identity; nothing else needs inventing.
function sessionKey(ref: SessionRef): string {
  return sessionDir(ref.projectDir, ref.sessionId);
}

/**
 * The run's own record of what it called, kept as the calls happen. A summary
 * built while the process still owns the bus reads this instead of the session
 * log, which is written asynchronously and bounded for its consumer — a call
 * that completed a moment ago may not be on disk yet, and an oversized record
 * reaches the log as a warning with its usage gone.
 *
 * The sink is seeded from whatever the session already logged, so a resumed run
 * summarizes every call the session made and not only this process's share.
 */
export function createCallEvidenceSink(ref: SessionRef): EventSink {
  const recorded = readLoggedCallEvents(ref) ?? [];
  liveRunCalls.set(sessionKey(ref), recorded);
  return (event) => {
    if (USAGE_EVIDENCE_EVENT_TYPES.has(event.type)) recorded.push(event);
  };
}

/**
 * One run's per-call usage evidence, from the live recorder when this process
 * ran the session and from its session log otherwise. A session that logged
 * nothing and ran nothing here returns `undefined` — the record predates call
 * attribution rather than reporting none.
 */
export function resolveCallUsageEvidence(ref: SessionRef): CallUsageEvidence[] | undefined {
  const events = liveRunCalls.get(sessionKey(ref)) ?? readLoggedCallEvents(ref);
  // The sink seeds an empty recorder when the session has no log, so an absent record and a
  // silent one both read as zero events here — either way the evidence predates attribution.
  if (events === null || events.length === 0) return undefined;
  return collectCallUsageEvidence(events);
}

function readLoggedCallEvents(ref: SessionRef): EngineEvent[] | null {
  const filePath = join(sessionDir(ref.projectDir, ref.sessionId), SESSION_LOG_FILE);
  if (!existsSync(filePath)) return null;

  const events: EngineEvent[] = [];
  try {
    // The summary path is synchronous, so it cannot consume the canonical async
    // reader in core/sessions/log-reader.ts; it carries that reader's two guards
    // instead — a symlinked log is refused, an oversized entry is skipped.
    if (lstatSync(filePath).isSymbolicLink()) return null;
    forEachLineSync(filePath, (line) => {
      if (!line.includes('"runner_call_')) return;
      if (Buffer.byteLength(line, 'utf8') > SESSION_LOG_MAX_ENTRY_BYTES) return;
      const parsedLine = parseJsonlLine(line);
      if (parsedLine.kind !== 'value') return;
      const entry = SessionLogEntrySchema.safeParse(parsedLine.value);
      if (!entry.success || entry.data.kind !== 'event') return;
      if (!USAGE_EVIDENCE_EVENT_TYPES.has(entry.data.type)) return;
      const event = engineEventFromLogEntry(entry.data);
      if (event !== null) events.push(event);
    });
  } catch {
    // Best-effort: an invalid session id or unreadable log never blocks the summary.
    return null;
  }
  return events;
}
