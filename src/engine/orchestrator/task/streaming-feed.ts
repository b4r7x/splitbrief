import type { TaskId } from '../../../core/schemas/task.js';
import { createRingBuffer } from '../../streaming/ring-buffer.js';

const STREAMING_FEED_FLUSH_MS = 50;
const STREAMING_FEED_MAX_LINES = 5;
const STREAMING_FEED_PREVIEW_MIN_CHARS = 20;

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
  const completedLines = createRingBuffer(STREAMING_FEED_MAX_LINES);
  let incompleteLine = '';
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingLines: string[] | null = null;

  sink.start(taskId);

  function flush(): void {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingLines === null) return;
    sink.replaceLines(pendingLines);
    pendingLines = null;
  }

  function scheduleFlush(): void {
    pendingLines = visibleLines();
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, STREAMING_FEED_FLUSH_MS);
  }

  function visibleLines(): string[] {
    const preview = incompleteLine.trim();
    const lines = completedLines.lines();
    if (preview.length <= STREAMING_FEED_PREVIEW_MIN_CHARS) return lines;
    return [...lines, preview].slice(-STREAMING_FEED_MAX_LINES);
  }

  function pushCompletedLine(line: string): void {
    if (line.trim().length > 0) completedLines.push(line);
  }

  function pushText(text: string): void {
    const parts = text.split('\n');
    if (parts.length === 1) {
      incompleteLine += text;
      return;
    }

    const [head, ...tail] = parts;
    pushCompletedLine(incompleteLine + (head ?? ''));
    for (const part of tail.slice(0, -1)) pushCompletedLine(part);
    incompleteLine = tail.at(-1) ?? '';
  }

  function flushTrailingRemainder(): void {
    if (incompleteLine.trim().length === 0) return;
    pushCompletedLine(incompleteLine);
    incompleteLine = '';
    pendingLines = visibleLines();
  }

  return {
    onText(text: string): void {
      pushText(text);
      scheduleFlush();
    },
    stop(): void {
      flushTrailingRemainder();
      flush();
      sink.stop();
    },
  };
}
