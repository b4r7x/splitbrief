import { describe, expect, it, vi } from 'vitest';
import { createStreamingFeed } from './streaming-feed.js';
import type { StreamingSink } from './streaming-feed.js';
import { taskId } from '../../../core/schemas/task.js';

function fakeSink(): StreamingSink & {
  lines: string[][];
  started: boolean;
  stopped: boolean;
} {
  const sink = {
    lines: [] as string[][],
    started: false,
    stopped: false,
    start: vi.fn(() => {
      sink.started = true;
    }),
    pushLines: vi.fn((l: string[]) => {
      sink.lines.push([...l]);
    }),
    stop: vi.fn(() => {
      sink.stopped = true;
    }),
  };
  return sink;
}

describe('createStreamingFeed', () => {
  it('ignores output for non-API runners', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T001'), false, sink);

    feed.onText('hello');
    feed.stop();

    expect(sink.start).not.toHaveBeenCalled();
    expect(sink.pushLines).not.toHaveBeenCalled();
    expect(sink.stop).not.toHaveBeenCalled();
  });

  it('streams API runner output into the sink until stopped', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T001'), true, sink);

    expect(sink.start).toHaveBeenCalledWith(taskId('T001'));

    feed.onText('first\n');
    expect(sink.lines.at(-1)).toEqual(['first']);

    feed.onText('\nsecond\n\nthird\n');
    expect(sink.lines.at(-1)).toEqual(['first', 'second', 'third']);

    feed.stop();
    expect(sink.stop).toHaveBeenCalled();
  });

  it('shows long incomplete lines before a newline arrives', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T001'), true, sink);
    const longLine = 'a'.repeat(21);

    feed.onText(longLine);

    expect(sink.lines.at(-1)).toEqual([longLine]);
    feed.stop();
  });
});
