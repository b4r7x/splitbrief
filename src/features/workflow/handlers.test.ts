import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortTurn,
  clearAllHandlers,
  consumeBoundaryInterrupt,
  createAbortHandlerScope,
  interruptTurn,
  requestClearQueue,
  setCancelHandler,
  setClearQueueHandler,
} from './handlers.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { registerProcess, unregisterProcess } from '../../lib/process/registry.js';

describe('createAbortHandlerScope', () => {
  afterEach(() => {
    clearAllHandlers();
  });

  it('abort handlers stack LIFO within a scope', () => {
    const setAbortHandler = createAbortHandlerScope();
    const outer = vi.fn();
    const inner = vi.fn();
    setAbortHandler(outer);
    setAbortHandler(inner);

    expect(abortTurn()).toBe(true);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    setAbortHandler(null);
    expect(abortTurn()).toBe(true);
    expect(outer).toHaveBeenCalledTimes(1);

    setAbortHandler(null);
    expect(abortTurn()).toBe(false);
  });

  it("a superseded scope's late pop cannot steal the next scope's handler", () => {
    const oldScope = createAbortHandlerScope();
    const oldHandler = vi.fn();
    oldScope(oldHandler);

    // Rewind: cleanup clears everything, then the next run opens its own scope
    // while the old run's aborted body is still settling.
    clearAllHandlers();
    const newScope = createAbortHandlerScope();
    const newHandler = vi.fn();
    newScope(newHandler);

    // The old body finally settles and issues its paired pop.
    oldScope(null);

    expect(abortTurn()).toBe(true);
    expect(newHandler).toHaveBeenCalledTimes(1);
    expect(oldHandler).not.toHaveBeenCalled();
  });
});

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

  it('interruptTurn kills processes and returns turn while a call is in flight', async () => {
    const abort = vi.fn();
    createAbortHandlerScope()(abort);
    const proc = spawn('sleep', ['60'], { stdio: 'ignore' });
    registerProcess(proc);

    try {
      expect(interruptTurn()).toBe('turn');
      expect(abort).toHaveBeenCalledTimes(1);
      expect(lifecycleStore.get().status).toBe('interrupted');
      expect(lifecycleStore.get().cancelled).toBe(false);

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('process did not exit')), 3000);
        proc.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(proc.signalCode === 'SIGTERM' || proc.exitCode !== null).toBe(true);
    } finally {
      unregisterProcess(proc);
      if (proc.exitCode === null && !proc.killed) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }
  });

  it('interruptTurn sets the boundary flag instead of cancelling during a dead zone', () => {
    const cancel = vi.fn();
    setCancelHandler(cancel);

    expect(interruptTurn()).toBe('turn');
    expect(cancel).not.toHaveBeenCalled();
    expect(lifecycleStore.get().status).toBe('interrupted');
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(consumeBoundaryInterrupt()).toBe(true);
  });

  it('a second interrupt while already interrupted plants no boundary flag', () => {
    setCancelHandler(vi.fn());

    expect(interruptTurn()).toBe('turn');
    expect(consumeBoundaryInterrupt()).toBe(true);

    // Parked at the interrupted prompt: another interrupt press must not queue
    // a stale boundary flag that would discard the next steering answer.
    expect(interruptTurn()).toBe('none');
    expect(consumeBoundaryInterrupt()).toBe(false);
    expect(lifecycleStore.get().cancelled).toBe(false);
  });

  it('falls back to cancel when no workflow handlers are registered', () => {
    expect(interruptTurn()).toBe('workflow');
    expect(lifecycleStore.get().cancelled).toBe(true);
  });

  it("returns 'none' when nothing can be stopped (no abort handler, already cancelled)", () => {
    lifecycleStore.__testReset({ phase: 'planning', cancelled: true });

    expect(interruptTurn()).toBe('none');
  });
});

describe('consumeBoundaryInterrupt', () => {
  beforeEach(() => {
    clearAllHandlers();
    lifecycleStore.reset();
    lifecycleStore.__testReset({ phase: 'planning' });
  });

  afterEach(() => {
    clearAllHandlers();
  });

  it('consumeBoundaryInterrupt reads and clears the pending flag', () => {
    expect(consumeBoundaryInterrupt()).toBe(false);

    setCancelHandler(vi.fn());
    interruptTurn();

    expect(consumeBoundaryInterrupt()).toBe(true);
    expect(consumeBoundaryInterrupt()).toBe(false);
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
