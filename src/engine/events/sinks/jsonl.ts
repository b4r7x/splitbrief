import { appendEngineEvent } from '../../../core/state/persistence.js';
import type { EngineEvent, EventSink } from '../types.js';

const TRANSCRIPT_KINDS = new Set<EngineEvent['type']>([
  'planner_text',
  'user_message',
  'clarifications_collected',
  'clarification_answered',
  'implementer_generate_done',
]);

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
