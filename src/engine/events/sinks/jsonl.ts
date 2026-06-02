import { appendEngineEvent } from '../../../core/state/persistence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { EngineEvent, EventSink } from '../types.js';

const TRANSCRIPT_KINDS = new Set<EngineEvent['type']>([
  'planner_text',
  'user_message',
  'clarifications_collected',
  'clarification_answered',
  'implementer_generate_done',
]);

export function createJsonlSink(opts: SessionRef & { persistTranscript: boolean }): EventSink {
  const { projectDir, sessionId, persistTranscript } = opts;
  const ref: SessionRef = { projectDir, sessionId };
  return (event) => {
    if (!persistTranscript && TRANSCRIPT_KINDS.has(event.type)) return;
    appendEngineEvent(ref, event);
  };
}
