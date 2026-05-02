import type { TaskId } from '../../../core/schemas/task.js';
import { createRingBuffer } from '../../streaming/ring-buffer.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';

export interface StreamingFeed {
  onText(text: string): void;
  stop(): void;
}

export function createStreamingFeed(taskId: TaskId, isApiRunner: boolean): StreamingFeed {
  if (!isApiRunner) {
    return { onText() {}, stop() {} };
  }

  const ringBuffer = createRingBuffer(5);
  let remainder = '';

  streamingOutputStore.startStreaming(taskId);

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
      streamingOutputStore.pushLines(ringBuffer.lines());
    },
    stop(): void {
      streamingOutputStore.stopStreaming();
    },
  };
}