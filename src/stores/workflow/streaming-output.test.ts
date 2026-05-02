import { describe, it, expect, beforeEach } from 'vitest';
import { streamingOutputStore } from './streaming-output.js';
import { taskId } from '../../core/schemas/task.js';

describe('streamingOutputStore', () => {
  beforeEach(() => streamingOutputStore.__testReset());

  it('startStreaming sets active=true, clears lines, sets taskId', () => {
    const id = taskId('T001');
    streamingOutputStore.startStreaming(id);
    const s = streamingOutputStore.get();
    expect(s.active).toBe(true);
    expect(s.lines).toEqual([]);
    expect(s.taskId).toBe(id);
  });

  it('pushLines updates lines when active', () => {
    streamingOutputStore.startStreaming(taskId('T001'));
    streamingOutputStore.pushLines(['hello', 'world']);
    expect(streamingOutputStore.get().lines).toEqual(['hello', 'world']);
  });

  it('pushLines is no-op when inactive', () => {
    streamingOutputStore.pushLines(['hello']);
    expect(streamingOutputStore.get().lines).toEqual([]);
  });

  it('stopStreaming sets active=false and preserves lines', () => {
    streamingOutputStore.startStreaming(taskId('T001'));
    streamingOutputStore.pushLines(['line1']);
    streamingOutputStore.stopStreaming();
    const s = streamingOutputStore.get();
    expect(s.active).toBe(false);
    expect(s.lines).toEqual(['line1']);
  });

  it('stopStreaming is no-op when already inactive', () => {
    streamingOutputStore.stopStreaming();
    expect(streamingOutputStore.get().active).toBe(false);
  });

  it('reset returns to initial state', () => {
    streamingOutputStore.startStreaming(taskId('T001'));
    streamingOutputStore.pushLines(['abc']);
    streamingOutputStore.reset();
    const s = streamingOutputStore.get();
    expect(s.active).toBe(false);
    expect(s.lines).toEqual([]);
    expect(s.taskId).toBeNull();
  });

  it('__testReset restores state for tests', () => {
    streamingOutputStore.startStreaming(taskId('T001'));
    streamingOutputStore.__testReset();
    expect(streamingOutputStore.get().active).toBe(false);

    streamingOutputStore.__testReset({ active: true, taskId: taskId('T042'), lines: ['x'] });
    expect(streamingOutputStore.get().active).toBe(true);
    expect(streamingOutputStore.get().taskId).toBe(taskId('T042'));
  });
});