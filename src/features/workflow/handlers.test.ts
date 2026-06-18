import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllHandlers, interruptTurn, setAbortHandler, setCancelHandler } from './handlers.js';
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
