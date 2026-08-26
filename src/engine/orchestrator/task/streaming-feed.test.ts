import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    replaceLines: vi.fn((l: string[]) => {
      sink.lines.push([...l]);
    }),
    stop: vi.fn(() => {
      sink.stopped = true;
    }),
  };
  return sink;
}

function flushThrottle(): void {
  vi.advanceTimersByTime(50);
}

describe('createStreamingFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams output into the sink until stopped', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T001'), sink);

    expect(sink.start).toHaveBeenCalledWith(taskId('T001'));

    feed.onText('first\n');
    flushThrottle();
    expect(sink.lines.at(-1)).toEqual(['first']);

    feed.onText('\nsecond\n\nthird\n');
    flushThrottle();
    expect(sink.lines.at(-1)).toEqual(['first', 'second', 'third']);

    feed.stop();
    expect(sink.stop).toHaveBeenCalled();
  });

  it('shows long incomplete lines before a newline arrives', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T001'), sink);
    const longLine = 'a'.repeat(21);

    feed.onText(longLine);
    flushThrottle();

    expect(sink.lines.at(-1)).toEqual([longLine]);
    feed.stop();
  });

  it('replaces an incomplete preview when its newline arrives', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T001'), sink);
    const longLine = 'a'.repeat(21);

    feed.onText(longLine);
    flushThrottle();
    expect(sink.lines.at(-1)).toEqual([longLine]);

    feed.onText('\n');
    flushThrottle();
    expect(sink.lines.at(-1)).toEqual([longLine]);

    feed.stop();
  });

  it('coalesces rapid line replacements into one sink update', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T001'), sink);

    feed.onText('first\n');
    feed.onText('second\n');

    expect(sink.replaceLines).not.toHaveBeenCalled();

    flushThrottle();

    expect(sink.replaceLines).toHaveBeenCalledTimes(1);
    expect(sink.lines.at(-1)).toEqual(['first', 'second']);
    feed.stop();
  });

  it('flushes pending lines before stopping', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T001'), sink);

    feed.onText('final\n');
    feed.stop();

    expect(sink.lines.at(-1)).toEqual(['final']);
    expect(sink.stop).toHaveBeenCalled();
  });

  it('flushes a short trailing remainder once when stopping', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T001'), sink);

    feed.onText('short');
    flushThrottle();
    expect(sink.lines.at(-1)).toEqual([]);

    feed.stop();

    expect(sink.lines.at(-1)).toEqual(['short']);
  });

  it('splits multi-line text and fills the ring buffer correctly', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T002'), sink);

    feed.onText('a\nb\nc\nd\ne\nf\n');
    flushThrottle();

    const lastPush = sink.lines.at(-1);
    expect(lastPush).toEqual(['b', 'c', 'd', 'e', 'f']);

    feed.stop();
  });

  it('stop() calls sink.stop()', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T003'), sink);

    feed.stop();
    expect(sink.stop).toHaveBeenCalledTimes(1);
  });
});
