import { sessionDir } from '../../../core/paths.js';
import { SessionLogEntrySchema } from '../../../core/schemas/session-log.js';
import { readSessionLogValuesSync } from '../../../core/sessions/log/reader.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { engineEventFromLogEntry } from '../../events/replay.js';
import type { EngineEvent, EventSink } from '../../events/types.js';
import { collectCallIdentities, type CallIdentity } from './call-identities.js';

const CALL_IDENTITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'runner_call_started',
  'runner_call_completed',
  'runner_call_error',
]);

const liveRunCalls = new Map<string, EngineEvent[]>();

// A session's own directory is its identity; nothing else needs inventing.
function sessionKey(ref: SessionRef): string {
  return sessionDir(ref.projectDir, ref.sessionId);
}

/** Keep the identity events from this process and earlier passes of the same run. */
export function createCallEvidenceSink(ref: SessionRef): EventSink {
  const recorded = readLoggedCallEvents(ref) ?? [];
  liveRunCalls.set(sessionKey(ref), recorded);
  return (event) => {
    if (CALL_IDENTITY_EVENT_TYPES.has(event.type)) recorded.push(event);
  };
}

/** Read a live run from its recorder and a saved run from its log. */
export function resolveCallIdentities(ref: SessionRef): CallIdentity[] | undefined {
  const events = liveRunCalls.get(sessionKey(ref)) ?? readLoggedCallEvents(ref);
  // The sink seeds an empty recorder when the session has no log, so an absent record and a
  // silent one both read as zero events here — either way the evidence predates attribution.
  if (events === null || events.length === 0) return undefined;
  return collectCallIdentities(events);
}

function readLoggedCallEvents(ref: SessionRef): EngineEvent[] | null {
  const values = readSessionLogValuesSync(ref, (line) => line.includes('"runner_call_'));
  if (values === null) return null;
  const events: EngineEvent[] = [];
  for (const value of values) {
    const entry = SessionLogEntrySchema.safeParse(value);
    if (!entry.success || entry.data.kind !== 'event') continue;
    if (!CALL_IDENTITY_EVENT_TYPES.has(entry.data.type)) continue;
    const event = engineEventFromLogEntry(entry.data);
    if (event !== null) events.push(event);
  }
  return events;
}
