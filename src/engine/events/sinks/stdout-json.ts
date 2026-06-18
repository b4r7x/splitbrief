import type { EventSink } from '../types.js';
import { writeHeadlessJsonRecord } from '../public-json.js';

export function createStdoutJsonSink(): EventSink {
  return (event) => {
    writeHeadlessJsonRecord({ type: 'event', data: event });
  };
}
