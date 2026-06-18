import {
  createSessionLogAppender,
  toEngineEventEntry,
  type SessionLogAppender,
} from '../../../core/state/persistence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { protectEngineEventForConsumer } from '../protection.js';
import type { EventSink } from '../types.js';

export function createJsonlSink(opts: SessionRef & { persistTranscript: boolean }): EventSink {
  const { projectDir, sessionId, persistTranscript } = opts;
  const ref: SessionRef = { projectDir, sessionId };
  let appender: SessionLogAppender | null = null;
  return (event) => {
    const protectedEvent = protectEngineEventForConsumer(event, {
      context: 'session-log',
      persistTranscript,
    });
    if (protectedEvent === null) return;
    if (appender === null) appender = createSessionLogAppender(ref);
    appender(toEngineEventEntry(protectedEvent));
  };
}
