import type { SessionLogEventEntry } from '../../core/schemas/session-log.js';
import { readSessionLogWithDiagnostics } from '../../core/sessions/log-reader.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { isRecord } from '../../utils/type-guards.js';
import { parseEngineEvent } from './schema.js';
import type { EngineEvent, EngineEventOf } from './types.js';

export interface RunReplayDiagnostics {
  total: number;
  skipped: number;
  unknownTypes: string[];
}

export interface RunReplay {
  events: EngineEvent[];
  diagnostics: RunReplayDiagnostics;
}

export async function readRunEvents(ref: SessionRef): Promise<RunReplay> {
  const { entries, diagnostics: read } = await readSessionLogWithDiagnostics(ref);

  const replayed: EngineEvent[] = [];
  const failedTypes: string[] = [];
  const parsedTypes = new Set<string>();
  let eventEntries = 0;

  for (const entry of entries) {
    if (entry.kind !== 'event') continue;
    eventEntries += 1;
    const event = engineEventFromLogEntry(entry);
    if (event === null) {
      if (!failedTypes.includes(entry.type)) failedTypes.push(entry.type);
      continue;
    }
    parsedTypes.add(entry.type);
    replayed.push(event);
  }

  const unknownTypes = failedTypes.filter((type) => !parsedTypes.has(type));
  const skipped = eventEntries - replayed.length;
  const diagnostics = {
    totalLines: read.totalLines,
    replayedEvents: replayed.length,
    skippedBlank: read.skippedBlank,
    skippedNonEvent: entries.length - eventEntries,
    skippedMalformed: read.skippedMalformed + read.skippedInvalid,
    skippedUnknown: skipped,
    skippedOversized: read.skippedOversized,
  };

  const firstTs = replayed[0]?.ts ?? Date.now();
  const lastTs = replayed[replayed.length - 1]?.ts ?? firstTs;
  const replayedSpanMs = lastTs - firstTs;

  const started: EngineEventOf<'replay_started'> = {
    type: 'replay_started',
    ts: firstTs,
    phase: 'idle',
    totalEvents: replayed.length,
    diagnostics,
  };

  const complete: EngineEventOf<'replay_complete'> = {
    type: 'replay_complete',
    ts: lastTs,
    phase: 'idle',
    totalEvents: replayed.length,
    durationMs: replayedSpanMs,
    diagnostics,
  };

  return {
    events: [started, ...replayed, complete],
    diagnostics: { total: eventEntries, skipped, unknownTypes },
  };
}

/** One logged line read back as the event that wrote it, timestamp quirks included. */
export function engineEventFromLogEntry(entry: SessionLogEventEntry): EngineEvent | null {
  const ts = entryTimestamp(entry.ts);
  if (ts === null) return null;
  const data = isRecord(entry.data) ? entry.data : {};
  return parseEngineEvent({
    ...data,
    type: entry.type,
    ts,
    ...(entry.phase !== undefined && { phase: entry.phase }),
    ...(entry.taskId !== undefined && { taskId: entry.taskId }),
  });
}

// The log timestamp schema still accepts the epoch-millisecond numbers older logs wrote,
// stringified on read; Date.parse rejects those, so fall back to the numeric reading.
function entryTimestamp(ts: string): number | null {
  if (ts.trim().length === 0) return null;
  const parsed = Date.parse(ts);
  if (!Number.isNaN(parsed)) return parsed;
  const numeric = Number(ts);
  return Number.isFinite(numeric) ? numeric : null;
}
