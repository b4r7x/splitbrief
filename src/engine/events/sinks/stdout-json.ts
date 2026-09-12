import type { EventSink } from '../types.js';
import { boundEngineEventForConsumer } from '../bound.js';
import { writeHeadlessJsonRecord } from '../public-json.js';

export interface StdoutJsonSinkOptions {
  output?: NodeJS.WritableStream | undefined;
}

export function createStdoutJsonSink(opts: StdoutJsonSinkOptions = {}): EventSink {
  const output = opts.output ?? process.stdout;

  return (event) => {
    const boundedEvent = boundEngineEventForConsumer(event, 'stdout-json');

    // A consumer's stdout pipe is a projection boundary. A closed pipe or a
    // failing writer must never turn into an authority result for the workflow.
    try {
      writeHeadlessJsonRecord({ type: 'event', data: boundedEvent }, output, {
        context: 'stdout-json',
      });
    } catch {
      // The EventBus also isolates sinks, but this boundary is intentionally
      // safe when invoked directly (and remains side-effect free on failure).
    }
  };
}
