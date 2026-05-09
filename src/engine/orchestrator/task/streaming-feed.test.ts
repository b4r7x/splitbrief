import { beforeEach, describe, expect, it } from 'vitest';
import { createStreamingFeed } from './streaming-feed.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { taskId } from '../../../core/schemas/task.js';

describe('createStreamingFeed', () => {
  beforeEach(() => streamingOutputStore.__testReset());

  it('ignores output for non-API runners', () => {
    const feed = createStreamingFeed(taskId('T001'), false);

    feed.onText('hello');
    feed.stop();

    expect(streamingOutputStore.get().active).toBe(false);
    expect(streamingOutputStore.get().lines).toEqual([]);
  });

  it('streams API runner output into the visible task feed until stopped', () => {
    const feed = createStreamingFeed(taskId('T001'), true);

    feed.onText('first\n');
    expect(streamingOutputStore.get().lines).toEqual(['first']);
    expect(streamingOutputStore.get().active).toBe(true);

    feed.onText('\nsecond\n\nthird\n');
    expect(streamingOutputStore.get().lines).toEqual(['first', 'second', 'third']);

    feed.stop();
    expect(streamingOutputStore.get().active).toBe(false);
    expect(streamingOutputStore.get().lines).toEqual(['first', 'second', 'third']);
  });

  it('shows long incomplete lines before a newline arrives', () => {
    const feed = createStreamingFeed(taskId('T001'), true);
    const longLine = 'a'.repeat(21);

    feed.onText(longLine);

    expect(streamingOutputStore.get().lines).toEqual([longLine]);
    feed.stop();
  });
});
