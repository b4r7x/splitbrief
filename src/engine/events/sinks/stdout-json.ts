import type { EventSink } from '../types.js';
import { protectEngineEventForConsumer } from '../protection.js';
import { writeHeadlessJsonRecord } from '../public-json.js';

export function createStdoutJsonSink(opts: { persistTranscript?: boolean } = {}): EventSink {
  const persistTranscript = opts.persistTranscript ?? true;
  return (event) => {
    const protectedEvent = protectEngineEventForConsumer(event, {
      context: 'stdout-json',
      persistTranscript,
    });
    if (protectedEvent === null) return;
    writeHeadlessJsonRecord({ type: 'event', data: protectedEvent });
  };
}
