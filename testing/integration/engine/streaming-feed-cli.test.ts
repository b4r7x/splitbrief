import { describe, expect, it, vi } from 'vitest';
import { createStreamingFeed, noopStreamingSink } from '../../../src/engine/orchestrator/task/streaming-feed.js';
import type { StreamingSink } from '../../../src/engine/orchestrator/task/streaming-feed.js';
import { taskId } from '../../../src/core/schemas/task.js';

function fakeSink(): StreamingSink & { lines: string[][]; started: boolean; stopped: boolean } {
  const sink = {
    lines: [] as string[][],
    started: false,
    stopped: false,
    start: vi.fn(() => { sink.started = true; }),
    pushLines: vi.fn((l: string[]) => { sink.lines.push([...l]); }),
    stop: vi.fn(() => { sink.stopped = true; }),
  };
  return sink;
}

describe('streaming feed without isApiRunner gate', () => {
  it('feeds text through the ring buffer to the sink', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T001'), sink);

    expect(sink.started).toBe(true);

    feed.onText('hello world\n');
    expect(sink.lines.at(-1)).toEqual(['hello world']);

    feed.onText('second line\n');
    expect(sink.lines.at(-1)).toEqual(['hello world', 'second line']);

    feed.stop();
    expect(sink.stopped).toBe(true);
    expect(sink.stop).toHaveBeenCalled();
  });

  it('splits multi-line text and fills the ring buffer correctly', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T002'), sink);

    feed.onText('a\nb\nc\nd\ne\nf\n');

    const lastPush = sink.lines.at(-1)!;
    expect(lastPush).toHaveLength(5);
    expect(lastPush).toEqual(['b', 'c', 'd', 'e', 'f']);

    feed.stop();
  });

  it('stop() calls sink.stop()', () => {
    const sink = fakeSink();
    const feed = createStreamingFeed(taskId('T003'), sink);

    feed.stop();
    expect(sink.stop).toHaveBeenCalledTimes(1);
  });

  it('works with noop sink without errors', () => {
    const feed = createStreamingFeed(taskId('T004'), noopStreamingSink);
    feed.onText('some text\n');
    feed.stop();
  });
});
