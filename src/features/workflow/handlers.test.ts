import { plainUserMessage } from '../../core/types/user-input.js';
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
  requestLeaveSession,
  setStopHandler,
  requestResume,
  requestSteer,
  requestStopNow,
  requestClearQueue,
  resumeParkedRun,
  setCancelHandler,
  setClearQueueHandler,
  setResumeHandler,
} from './handlers.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { routerStore } from '../../stores/navigation/router.js';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
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

    expect(requestResume(plainUserMessage('use the other adapter'))).toBe(true);
    expect(resume).toHaveBeenCalledWith(plainUserMessage('use the other adapter'));
    // The run decides what continuing means; nothing settles behind its back.
    expect(steer).not.toHaveBeenCalled();
  });

  it('reports nothing to resume when no run is on screen', () => {
    expect(requestResume(plainUserMessage(''))).toBe(false);
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

    expect(resumeParkedRun(plainUserMessage('use the other adapter'))).toBe(true);
    expect(steer).toHaveBeenCalledWith(plainUserMessage('use the other adapter'));
    expect(stopStore.get().phase).toBe('idle');
  });

  it('settles a boundary park so the run starts the next brief', () => {
    const steer = vi.fn();
    stopStore.request('pause-after-brief');
    stopStore.park('boundary', 'T001', steer);

    expect(resumeParkedRun(plainUserMessage(''))).toBe(true);
    expect(steer).toHaveBeenCalledWith(plainUserMessage(''));
  });

  it('reports no park when the run is at rest', () => {
    expect(resumeParkedRun(plainUserMessage(''))).toBe(false);
  });

  it('leaves a resolverless park for the saved-state continuation', () => {
    stopStore.park('mid-brief', 'T001', null);

    expect(resumeParkedRun(plainUserMessage('keep the greeting API'))).toBe(false);
    expect(stopStore.get().phase).toBe('parked');
  });
});

describe('requestSteer', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  afterEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
  });

  it('stops now and holds the text until the park lands', () => {
    const stop = vi.fn();
    setStopHandler(stop);

    expect(requestSteer(plainUserMessage('smaller diffs'))).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);

    // The text survives the stop race: the park that follows resumes with it.
    const steer = vi.fn();
    stopStore.park('mid-brief', 'T002', steer);
    expect(steer).toHaveBeenCalledWith(plainUserMessage('smaller diffs'));
  });

  it('continues a run already parked with the text', () => {
    const steer = vi.fn();
    stopStore.park('mid-brief', 'T002', steer);

    expect(requestSteer(plainUserMessage('use the other adapter'))).toBe(true);
    expect(steer).toHaveBeenCalledWith(plainUserMessage('use the other adapter'));
  });

  it('reports nothing to steer when no run is on screen', () => {
    expect(requestSteer(plainUserMessage('nope'))).toBe(false);
  });

  it('hands a resolverless park to the run continuation with its attachments', () => {
    const resume = vi.fn();
    setResumeHandler(resume);
    stopStore.park('mid-brief', 'T001', null);
    const message = {
      ...plainUserMessage('keep the greeting API'),
      attachedInputs: [{ path: '/tmp/send-now-note.md', kind: 'text' as const }],
    };

    expect(requestSteer(message)).toBe(true);
    expect(resume).toHaveBeenCalledExactlyOnceWith(message);
  });

  it.each([
    ['stop', requestStopNow],
    ['end run', requestEndRun],
  ] as const)('an explicit %s supersedes a pending steer', (_name, stop) => {
    lifecycleStore.__testReset({ phase: 'implementing', cancelled: false });
    setStopHandler(vi.fn());
    setCancelHandler(vi.fn());
    createAbortHandlerScope()(vi.fn());
    expect(requestSteer(plainUserMessage('keep the greeting API'))).toBe(true);

    expect(stop()).toBe(true);
    const resolve = vi.fn();
    stopStore.park('mid-brief', 'T001', resolve);

    expect(resolve).not.toHaveBeenCalled();
    expect(stopStore.get().phase).toBe('parked');
  });

  it('delivers the steer exactly once when the stop parks synchronously', () => {
    const resolve = vi.fn();
    setStopHandler(() => stopStore.park('mid-brief', 'T001', resolve));
    const message = plainUserMessage('keep the greeting API');

    expect(requestSteer(message)).toBe(true);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(message);
    expect(stopStore.get().phase).toBe('idle');
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

describe('safe departure', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.reset();
    routerStore.reset();
  });
  afterEach(() => {
    clearAllHandlers();
    stopStore.reset();
    routerStore.reset();
  });

  it('observes a synchronous stop and invokes exit exactly once', () => {
    const stop = vi.fn(() => stopStore.park('mid-brief', null, null));
    setStopHandler(stop);
    const exit = vi.fn();
    requestQuit(exit);
    stopStore.end();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('keeps one stop request while quit supersedes pending home', () => {
    const stop = vi.fn();
    setStopHandler(stop);
    const exit = vi.fn();
    const home = vi.spyOn(routerStore, 'navigate');
    requestStopNow();
    const requestedAt = stopStore.get().requestedAt;
    requestLeaveSession();
    requestQuit(exit);
    requestQuit(exit);
    requestLeaveSession();
    expect(exit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopStore.get().requestedAt).toBe(requestedAt);
    stopStore.park('mid-brief', null, null);
    expect(home).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    home.mockRestore();
  });

  it('unwinds a boundary promise before delivering exit', () => {
    stopStore.request('pause-after-brief');
    const resolve = vi.fn();
    stopStore.park('boundary', 'T001', resolve);
    const stop = vi.fn(() => stopStore.get().parked?.resolve?.(plainUserMessage('')));
    setStopHandler(stop);
    const exit = vi.fn();
    requestQuit(exit);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    stopStore.park('boundary', 'T001', null);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('cancels departure on a failed save and retries the original explicit end intent', () => {
    const stop = vi.fn();
    setStopHandler(stop);
    stopStore.request('end-run');
    const exit = vi.fn();
    requestQuit(exit);
    stopStore.fail('Disk full');
    expect(exit).not.toHaveBeenCalled();
    expect(requestStopNow()).toBe(true);
    expect(stopStore.get()).toMatchObject({ intent: 'end-run', phase: 'requested' });
    expect(stopStore.get().error).toBeUndefined();
    stopStore.end();
    expect(exit).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not deliver stale departure after changing sessions', () => {
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir: '/tmp', sessionId: 'first' } }),
      execution: { kind: 'at-rest' },
    });
    setStopHandler(vi.fn());
    const exit = vi.fn();
    requestQuit(exit);
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir: '/tmp', sessionId: 'second' } }),
      execution: { kind: 'at-rest' },
    });
    stopStore.park('mid-brief', null, null);
    expect(exit).not.toHaveBeenCalled();
  });
});
