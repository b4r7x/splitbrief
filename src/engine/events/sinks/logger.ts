import { createLogger } from '../../../lib/logger.js';
import { boundEngineEventForConsumer } from '../bound.js';
import type { EventSink } from '../types.js';

export function createLoggerSink(): EventSink {
  const log = createLogger('engine');
  return (rawEvent) => {
    const event = boundEngineEventForConsumer(rawEvent, 'session-log');
    if (event.type === 'error') log.error(event.type, event);
    else if (event.type === 'warning') log.warn(event.type, event);
    else log.debug(event.type, event);
  };
}
