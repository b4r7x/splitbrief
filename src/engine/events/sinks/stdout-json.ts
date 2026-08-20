import type { EventSink } from '../types.js';
import { protectEngineEventForConsumer } from '../protection/protect.js';
import { writeHeadlessJsonRecord } from '../public-json.js';

export interface StdoutJsonSinkOptions {
  persistTranscript?: boolean | undefined;
  output?: NodeJS.WritableStream | undefined;
}

export function createStdoutJsonSink(opts: StdoutJsonSinkOptions = {}): EventSink {
  const persistTranscript = opts.persistTranscript ?? true;
  const output = opts.output ?? process.stdout;

  return (event) => {
    const protectedEvent = protectEngineEventForConsumer(event, {
      context: 'stdout-json',
      persistTranscript,
    });
    if (protectedEvent === null) return;

    // A consumer's stdout pipe is a projection boundary. A closed pipe or a
    // failing writer must never turn into an authority result for the workflow.
    try {
      writeHeadlessJsonRecord({ type: 'event', data: protectedEvent }, output, {
        context: 'stdout-json',
        persistTranscript,
      });
    } catch {
      // The EventBus also isolates sinks, but this boundary is intentionally
      // safe when invoked directly (and remains side-effect free on failure).
    }
  };
}
