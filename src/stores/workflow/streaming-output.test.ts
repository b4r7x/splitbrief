import { describe, it, expect, beforeEach } from 'vitest';
import { streamingOutputStore } from './streaming-output.js';
import { taskId } from '../../core/schemas/task.js';

describe('streamingOutputStore', () => {
  beforeEach(() => streamingOutputStore.reset());

  it('streams output for the active task until the stream is stopped', () => {
    const id = taskId('T001');
    streamingOutputStore.startStreaming(id);
    streamingOutputStore.pushLines(['hello', 'world']);

    expect(streamingOutputStore.get()).toEqual({
      active: true,
      lines: ['hello', 'world'],
      taskId: id,
    });

    streamingOutputStore.stopStreaming();
    streamingOutputStore.pushLines(['ignored after stop']);

    expect(streamingOutputStore.get()).toEqual({
      active: false,
      lines: ['hello', 'world'],
      taskId: id,
    });
  });

  it('ignores output outside an active stream and can return to an idle state', () => {
    streamingOutputStore.pushLines(['ignored before start']);
    streamingOutputStore.stopStreaming();

    expect(streamingOutputStore.get()).toEqual({
      active: false,
      lines: [],
      taskId: null,
    });

    streamingOutputStore.startStreaming(taskId('T001'));
    streamingOutputStore.pushLines(['visible']);
    streamingOutputStore.reset();

    expect(streamingOutputStore.get()).toEqual({
      active: false,
      lines: [],
      taskId: null,
    });
  });
});
