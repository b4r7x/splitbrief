import { describe, it, expect, beforeEach } from 'vitest';
import { createStreamingFeed } from './streaming-feed.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { taskId } from '../../../core/schemas/task.js';

describe('createStreamingFeed', () => {
  beforeEach(() => streamingOutputStore.__testReset());

  it('returns no-op feed when isApiRunner is false', () => {
    const feed = createStreamingFeed(taskId('T001'), false);
    feed.onText('hello');
    feed.stop();
    expect(streamingOutputStore.get().active).toBe(false);
    expect(streamingOutputStore.get().lines).toEqual([]);
  });

  it('feeds lines through to the store when isApiRunner is true', () => {
    const feed = createStreamingFeed(taskId('T001'), true);
    feed.onText('line1\nline2\n');
    expect(streamingOutputStore.get().lines).toEqual(['line1', 'line2']);
    feed.stop();
  });

  it('calls stopStreaming on stop', () => {
    const feed = createStreamingFeed(taskId('T001'), true);
    feed.onText('data\n');
    feed.stop();
    expect(streamingOutputStore.get().active).toBe(false);
  });

  it('accumulates lines across multiple onText calls', () => {
    const feed = createStreamingFeed(taskId('T001'), true);
    feed.onText('first\n');
    expect(streamingOutputStore.get().lines).toEqual(['first']);
    feed.onText('second\n');
    expect(streamingOutputStore.get().lines).toEqual(['first', 'second']);
    feed.stop();
  });

  it('shows long incomplete lines mid-stream', () => {
    const feed = createStreamingFeed(taskId('T001'), true);
    const longLine = 'a'.repeat(21);
    feed.onText(longLine);
    expect(streamingOutputStore.get().lines).toEqual([longLine.trim()]);
    feed.stop();
  });

  it('ignores blank lines', () => {
    const feed = createStreamingFeed(taskId('T001'), true);
    feed.onText('hello\n\n\nworld\n');
    expect(streamingOutputStore.get().lines).toEqual(['hello', 'world']);
    feed.stop();
  });

  it('resets between tests', () => {
    const feed = createStreamingFeed(taskId('T001'), true);
    feed.onText('line\n');
    feed.stop();
    streamingOutputStore.__testReset();
    expect(streamingOutputStore.get().active).toBe(false);
    expect(streamingOutputStore.get().lines).toEqual([]);
  });
});