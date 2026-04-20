import type { EventSink } from '../types.js';

export function createStdoutJsonSink(): EventSink {
  return (event) => {
    process.stdout.write(JSON.stringify(event) + '\n');
  };
}
