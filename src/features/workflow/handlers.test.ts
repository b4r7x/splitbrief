import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllHandlers,
  interruptTurn,
  requestClearQueue,
  setAbortHandler,
  setCancelHandler,
  setClearQueueHandler,
} from './handlers.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { eventsStore } from '../../stores/workflow/events.js';

describe('interruptTurn', () => {
  beforeEach(() => {
    clearAllHandlers();
    lifecycleStore.reset();
    eventsStore.reset();
    lifecycleStore.__testReset({ phase: 'planning' });
  });

  afterEach(() => {
    clearAllHandlers();
  });

  it("returns 'turn' and aborts when an abort handler is registered", () => {
    const abort = vi.fn();
    setAbortHandler(abort);

    expect(interruptTurn()).toBe('turn');
    expect(lifecycleStore.get().cancelled).toBe(false);
  });

  it("falls back to 'workflow' (cancel) when no abort handler exists", () => {
    const cancel = vi.fn();
    setCancelHandler(cancel);

    expect(interruptTurn()).toBe('workflow');
    expect(lifecycleStore.get().cancelled).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns 'none' when nothing can be stopped (no abort handler, already cancelled)", () => {
    lifecycleStore.__testReset({ phase: 'planning', cancelled: true });

    expect(interruptTurn()).toBe('none');
  });
});

describe('requestClearQueue', () => {
  beforeEach(() => {
    clearAllHandlers();
    lifecycleStore.reset();
    eventsStore.reset();
    lifecycleStore.__testReset({ phase: 'planning', queueDepth: 2 });
  });

  afterEach(() => {
    clearAllHandlers();
  });

  it('returns unavailable and does not mutate lifecycle or events when no handler exists', () => {
    expect(requestClearQueue()).toEqual({
      status: 'unavailable',
      message: 'Queue clear is not available for this workflow.',
    });
    expect(lifecycleStore.get().queueDepth).toBe(2);
    expect(eventsStore.get().events).toEqual([]);
  });

  it('delegates to the registered clear handler', () => {
    const clear = vi.fn(() => ({ status: 'cleared' as const, count: 2 }));
    setClearQueueHandler(clear);

    expect(requestClearQueue()).toEqual({ status: 'cleared', count: 2 });
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
