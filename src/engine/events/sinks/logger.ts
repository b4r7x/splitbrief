import { createLogger } from '../../../lib/logger.js';
import { protectEngineEventForConsumer } from '../protection/protect.js';
import type { EventSink } from '../types.js';

export function createLoggerSink(opts: { persistTranscript: boolean }): EventSink {
  const log = createLogger('engine');
  return (rawEvent) => {
    const event = protectEngineEventForConsumer(rawEvent, {
      context: 'session-log',
      persistTranscript: opts.persistTranscript,
    });
    if (event === null) return;
    if (event.type === 'error') log.error(event.type, event);
    else if (event.type === 'warning') log.warn(event.type, event);
    else log.debug(event.type, event);
  };
}
