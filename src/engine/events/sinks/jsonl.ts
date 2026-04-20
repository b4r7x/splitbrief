import { appendEngineEvent } from '../../../core/state/persistence.js';
import type { EngineEvent, EventSink } from '../types.js';

const TRANSCRIPT_KINDS = new Set<EngineEvent['type']>(['planner_text']);

export function createJsonlSink(
  projectDir: string,
  sessionId: string,
  persistTranscript: boolean,
): EventSink {
  return (event) => {
    if (!persistTranscript && TRANSCRIPT_KINDS.has(event.type)) return;
    appendEngineEvent(projectDir, sessionId, event);
  };
}
