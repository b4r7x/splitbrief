import type { TaskId } from '../../../core/schemas/task.js';
import { createRingBuffer } from '../../streaming/ring-buffer.js';

export interface StreamingSink {
  start(taskId: TaskId): void;
  pushLines(lines: string[]): void;
  stop(): void;
}

export const noopStreamingSink: StreamingSink = {
  start() {},
  pushLines() {},
  stop() {},
};

export interface StreamingFeed {
  onText(text: string): void;
  stop(): void;
}

export function createStreamingFeed(
  taskId: TaskId,
  sink: StreamingSink,
): StreamingFeed {
  const ringBuffer = createRingBuffer(5);
  let remainder = '';

  sink.start(taskId);

  return {
    onText(text: string): void {
      remainder += text;
      const parts = remainder.split('\n');
      remainder = parts.pop() ?? '';
      for (const line of parts) {
        if (line.trim().length > 0) {
          ringBuffer.push(line);
        }
      }
      if (remainder.trim().length > 20) {
        ringBuffer.push(remainder.trim());
      }
      sink.pushLines(ringBuffer.lines());
    },
    stop(): void {
      sink.stop();
    },
  };
}