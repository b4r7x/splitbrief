import { plainUserMessage } from '../../../core/types/user-input.js';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  abortTurn,
  clearAllHandlers,
  createAbortHandlerScope,
  setStopHandler,
  requestClearQueue,
  setClearQueueHandler,
} from './registry.js';
import { requestQuit } from './departure.js';
import { requestSteer } from './stop-resume.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { eventsStore } from '../../../stores/workflow/events/state.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { departureStore } from '../../../stores/workflow/departure.js';

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

  it('a scope that the clear of the handlers dropped takes no late push', () => {
    const oldScope = createAbortHandlerScope();
    clearAllHandlers();

    const lateHandler = vi.fn();
    oldScope(lateHandler);

    expect(abortTurn()).toBe(false);
    expect(lateHandler).not.toHaveBeenCalled();
  });
});

describe('clearAllHandlers', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    departureStore.__testReset();
    routerStore.reset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    departureStore.__testReset();
    routerStore.reset();
  });

  // The order in which the clear writes the stores and lets go of its stop store subscriptions.
  function recordDispose(): string[] {
    const order: string[] = [];
    const { subscribe, markSeatChange } = stopStore;
    const { reset } = departureStore;
    const spies = [
      vi.spyOn(stopStore, 'subscribe').mockImplementation((listener) => {
        const unsubscribe = subscribe(listener);
        return () => {
          order.push('unsubscribe');
          unsubscribe();
        };
      }),
      vi.spyOn(stopStore, 'markSeatChange').mockImplementation((pending) => {
        order.push(`seat change ${String(pending)}`);
        markSeatChange(pending);
      }),
      vi.spyOn(departureStore, 'reset').mockImplementation(() => {
        order.push('departure reset');
        reset();
      }),
    ];
    onTestFinished(() => {
      for (const spy of spies) spy.mockRestore();
    });
    return order;
  }

  it('lets go of a held steer once, after it clears the seat change', () => {
    const order = recordDispose();
    setStopHandler(vi.fn());
    expect(requestSteer(plainUserMessage('smaller diffs'))).toBeUndefined();

    clearAllHandlers();
    clearAllHandlers();

    expect(order).toEqual(['seat change false', 'unsubscribe', 'seat change false']);
    const resolve = vi.fn();
    stopStore.park('mid-brief', 'T002', resolve);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('drops a quit that waits on the stop and lets go of it once, before it clears the seat change', () => {
    const order = recordDispose();
    setStopHandler(vi.fn());
    const exit = vi.fn();
    requestQuit(exit);
    expect(departureStore.get()?.kind).toBe('quit');

    clearAllHandlers();
    clearAllHandlers();

    expect(order).toEqual([
      'departure reset',
      'unsubscribe',
      'seat change false',
      'seat change false',
    ]);
    expect(departureStore.get()).toBeNull();
    stopStore.park('mid-brief', 'T002', null);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('requestClearQueue', () => {
  beforeEach(() => {
    clearAllHandlers();
    lifecycleStore.reset();
    eventsStore.reset();
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ queueDepth: 2, status: 'running' });
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
