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
  const parsedEvents = entries.map((entry) =>
    entry.kind === 'event' ? engineEventFromLogEntry(entry) : null,
  );
  const pairedUserEvents = new Set<number>();
  let eventEntries = 0;
  let restoredMessages = 0;

  for (const [index, entry] of entries.entries()) {
    if (entry.kind === 'message' && entry.role === 'user') {
      // Message/event pairs are adjacent writes. Equal replies in later turns are distinct.
      const pairedIndex = [index - 1, index + 1].find((candidateIndex) => {
        const candidate = parsedEvents[candidateIndex];
        return (
          !pairedUserEvents.has(candidateIndex) &&
          candidate?.type === 'user_message' &&
          candidate.text === entry.text &&
          (entry.phase === undefined || candidate.phase === entry.phase)
        );
      });
      if (pairedIndex !== undefined) {
        pairedUserEvents.add(pairedIndex);
        continue;
      }
      const ts = entryTimestamp(entry.ts);
      if (ts !== null) {
        replayed.push({
          type: 'user_message',
          ts,
          phase: entry.phase ?? 'idle',
          text: entry.text,
          ...(entry.qa !== undefined && { qa: entry.qa }),
        });
        restoredMessages += 1;
      }
      continue;
    }
    if (entry.kind !== 'event') continue;
    eventEntries += 1;
    const event = parsedEvents[index];
    if (event === null || event === undefined) {
      if (!failedTypes.includes(entry.type)) failedTypes.push(entry.type);
      continue;
    }
    parsedTypes.add(entry.type);
    replayed.push(event);
  }

  const unknownTypes = failedTypes.filter((type) => !parsedTypes.has(type));
  const skipped = eventEntries - (replayed.length - restoredMessages);
  const diagnostics = {
    totalLines: read.totalLines,
    replayedEvents: replayed.length,
    skippedBlank: read.skippedBlank,
    skippedNonEvent: entries.length - eventEntries - restoredMessages,
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
export function entryTimestamp(ts: string): number | null {
  if (ts.trim().length === 0) return null;
  const parsed = Date.parse(ts);
  if (!Number.isNaN(parsed)) return parsed;
  const numeric = Number(ts);
  return Number.isFinite(numeric) ? numeric : null;
}
