import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  abortTurn,
  cancelBoundaryPause,
  clearAllHandlers,
  consumeBoundaryInterrupt,
  consumeBoundaryPause,
  createAbortHandlerScope,
  requestBoundaryPause,
  requestEndRun,
  requestQuit,
  requestResume,
  requestStopNow,
  requestClearQueue,
  resumeParkedRun,
  setCancelHandler,
  setClearQueueHandler,
  setResumeHandler,
} from './handlers.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { stopStore } from '../../stores/workflow/stop.js';

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

describe('requestStopNow', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    lifecycleStore.reset();
    eventsStore.reset();
    lifecycleStore.__testReset({ phase: 'planning' });
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('stop now aborts an escalation call', () => {
    const abortEscalation = vi.fn();
    createAbortHandlerScope()(abortEscalation);

    expect(requestStopNow()).toBe(true);
    expect(abortEscalation).toHaveBeenCalledTimes(1);
    expect(stopStore.get()).toMatchObject({ intent: 'stop-now', phase: 'requested' });
    expect(lifecycleStore.get().cancelled).toBe(false);
  });

  it('flags the next boundary when no call is in flight', () => {
    const cancel = vi.fn();
    setCancelHandler(cancel);

    expect(requestStopNow()).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    expect(consumeBoundaryInterrupt()).toBe(true);
  });

  it('announces no stop when there is nothing to stop', () => {
    expect(requestStopNow()).toBe(false);
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
  });
});

describe('requestBoundaryPause', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('hands the engine one pause and clears it on the way out', () => {
    requestBoundaryPause();

    expect(stopStore.get().intent).toBe('pause-after-brief');
    expect(consumeBoundaryPause()).toBe(true);
    expect(consumeBoundaryPause()).toBe(false);
  });

  it('keeps running drops the pending pause', () => {
    requestBoundaryPause();
    cancelBoundaryPause();

    expect(consumeBoundaryPause()).toBe(false);
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
  });
});

describe('requestEndRun', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    lifecycleStore.reset();
    eventsStore.reset();
    lifecycleStore.__testReset({ phase: 'planning' });
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('cancels the run and records the intent', () => {
    const cancel = vi.fn();
    setCancelHandler(cancel);

    expect(requestEndRun()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(lifecycleStore.get().cancelled).toBe(true);
    expect(stopStore.get().intent).toBe('end-run');
  });
});

describe('requestResume', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('hands every continuation to the run, park or no park', () => {
    const resume = vi.fn();
    const steer = vi.fn();
    setResumeHandler(resume);
    stopStore.park('mid-brief', 'T002', steer);

    expect(requestResume('use the other adapter')).toBe(true);
    expect(resume).toHaveBeenCalledWith('use the other adapter');
    // The run decides what continuing means; nothing settles behind its back.
    expect(steer).not.toHaveBeenCalled();
  });

  it('reports nothing to resume when no run is on screen', () => {
    expect(requestResume('')).toBe(false);
  });
});

describe('resumeParkedRun', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('settles a parked brief with the typed steer', () => {
    const steer = vi.fn();
    stopStore.park('mid-brief', 'T002', steer);

    expect(resumeParkedRun('use the other adapter')).toBe(true);
    expect(steer).toHaveBeenCalledWith('use the other adapter');
    expect(stopStore.get().phase).toBe('idle');
  });

  it('settles a boundary park so the run starts the next brief', () => {
    const steer = vi.fn();
    stopStore.request('pause-after-brief');
    stopStore.park('boundary', 'T001', steer);

    expect(resumeParkedRun('')).toBe(true);
    expect(steer).toHaveBeenCalledWith('');
  });

  it('reports no park when the run is at rest', () => {
    expect(resumeParkedRun('')).toBe(false);
  });
});

describe('requestQuit', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('exits at once when there is no run to stop', () => {
    const exit = vi.fn();

    requestQuit(exit);

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('waits for the run to park before leaving', () => {
    const exit = vi.fn();
    createAbortHandlerScope()(vi.fn());

    requestQuit(exit);
    expect(exit).not.toHaveBeenCalled();

    stopStore.park('mid-brief', 'T002', null);
    expect(exit).toHaveBeenCalledTimes(1);
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
    requestStopNow();

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
