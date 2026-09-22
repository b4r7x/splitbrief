import {
  createSessionLogAppender,
  toEngineEventEntry,
  type SessionLogAppendFailure,
  type SessionLogAppender,
} from '../../../core/sessions/log-writer.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { boundEngineEventForConsumer } from '../bound.js';
import type { EngineEvent, EventSink } from '../types.js';

type JsonlSinkOptions = SessionRef & {
  onDegraded?: ((warning: Extract<EngineEvent, { type: 'warning' }>) => void) | undefined;
};

/**
 * The three highest-volume event kinds, none of which is read back from the
 * session log: streamed text, tool-input deltas, and planner heartbeats.
 */
function isExcludedFromSessionLog(event: EngineEvent): boolean {
  if (event.type === 'runner_call_text_delta') return true;
  if (event.type === 'planner_heartbeat') return true;
  return event.type === 'runner_call_tool_use' && event.stage === 'delta';
}

function createJsonlDegradedWarning(
  failure: SessionLogAppendFailure | 'write-threw',
): Extract<EngineEvent, { type: 'warning' }> {
  return {
    type: 'warning',
    ts: Date.now(),
    phase: 'idle',
    category: 'jsonl',
    code: 'session_log_degraded',
    message: `Session JSONL sink is degraded; session.jsonl writes are failing (${failure}).`,
  };
}

export function createJsonlSink(opts: JsonlSinkOptions): EventSink {
  const { projectDir, sessionId, onDegraded } = opts;
  const ref: SessionRef = { projectDir, sessionId };
  let appender: SessionLogAppender | null = null;
  let degraded = false;

  function reportDegraded(failure: SessionLogAppendFailure | 'write-threw'): void {
    if (degraded) return;
    degraded = true;
    onDegraded?.(createJsonlDegradedWarning(failure));
  }

  return (event) => {
    if (isExcludedFromSessionLog(event)) return;
    const boundedEvent = boundEngineEventForConsumer(event, 'session-log');
    if (appender === null) appender = createSessionLogAppender(ref, { onFailure: reportDegraded });
    try {
      appender(toEngineEventEntry(boundedEvent));
    } catch {
      reportDegraded('write-threw');
    }
  };
}
