import type { TaskId } from '../../../core/schemas/task.js';
import { createRingBuffer } from '../../streaming/ring-buffer.js';
import { createLineBuffer } from '../../../lib/process/line-buffer.js';

export interface StreamingSink {
  start(taskId: TaskId): void;
  replaceLines(lines: string[]): void;
  stop(): void;
}

export const noopStreamingSink: StreamingSink = {
  start() {},
  replaceLines() {},
  stop() {},
};

export interface StreamingFeed {
  onText(text: string): void;
  stop(): void;
}

export function createStreamingFeed(taskId: TaskId, sink: StreamingSink): StreamingFeed {
  const ringBuffer = createRingBuffer(5);
  let remainder = '';
  const lineBuffer = createLineBuffer((line) => {
    if (line.trim().length > 0) ringBuffer.push(line);
  });

  sink.start(taskId);

  return {
    onText(text: string): void {
      lineBuffer.push(text);
      remainder = text.includes('\n') ? text.slice(text.lastIndexOf('\n') + 1) : remainder + text;
      if (remainder.trim().length > 20) {
        ringBuffer.push(remainder.trim());
      }
      sink.replaceLines(ringBuffer.lines());
    },
    stop(): void {
      sink.stop();
    },
  };
}
