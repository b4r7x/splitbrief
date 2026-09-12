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
    const boundedEvent = boundEngineEventForConsumer(event, 'session-log');
    if (appender === null) appender = createSessionLogAppender(ref, { onFailure: reportDegraded });
    try {
      appender(toEngineEventEntry(boundedEvent));
    } catch {
      reportDegraded('write-threw');
    }
  };
}
