import { plainUserMessage } from '../../../core/types/user-input.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllHandlers, setCancelHandler } from './registry.js';
import {
  cancelBoundaryPause,
  consumeBoundaryInterrupt,
  consumeBoundaryPause,
  landBoundaryPause,
  requestBoundaryPause,
  requestSeatChangeAtBoundary,
  seatChangeWaits,
  spendSeatChange,
} from './boundary.js';
import { requestStopNow, resumeParkedRun } from './stop-resume.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { stopStore } from '../../../stores/workflow/stop.js';

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
    expect(consumeBoundaryPause()).toBe('pause');
    expect(consumeBoundaryPause()).toBeUndefined();
  });

  it('pauses once: the boundary after the request takes the pause, the run parks there, and the next boundary goes on', () => {
    requestBoundaryPause();
    expect(stopStore.get()).toMatchObject({ intent: 'pause-after-brief', phase: 'requested' });
    expect(seatChangeWaits()).toBe(false);

    expect(consumeBoundaryPause()).toBe('pause');
    expect(landBoundaryPause()).toBe('park');
    const resolve = vi.fn();
    stopStore.park('boundary', 'T001', resolve);
    expect(resumeParkedRun(plainUserMessage(''))).toBe(true);

    expect(resolve).toHaveBeenCalledExactlyOnceWith(plainUserMessage(''));
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
    expect(consumeBoundaryPause()).toBeUndefined();
  });

  it('announces a pause before it arms it, and withdraws it before the store takes it back', () => {
    requestSeatChangeAtBoundary();
    const seen: boolean[] = [];
    const off = stopStore.subscribe(() => seen.push(seatChangeWaits()));

    requestBoundaryPause();
    expect(seatChangeWaits()).toBe(false);
    cancelBoundaryPause();
    off();

    expect(seen).toEqual([true, true]);
    expect(seatChangeWaits()).toBe(true);
  });

  it('keeps running drops the pending pause', () => {
    requestBoundaryPause();
    cancelBoundaryPause();

    expect(consumeBoundaryPause()).toBeUndefined();
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
  });

  it('a seat change asks the engine for the boundary and arms no pause of the operator', () => {
    requestSeatChangeAtBoundary();

    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', seatChange: true });
    expect(consumeBoundaryPause()).toBe('seat-change');
  });

  it('spending a seat change leaves no boundary to stop at', () => {
    requestSeatChangeAtBoundary();
    spendSeatChange();

    expect(consumeBoundaryPause()).toBeUndefined();
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', seatChange: false });
  });

  it('a pause the operator asked for wins over a seat change', () => {
    requestBoundaryPause();
    requestSeatChangeAtBoundary();

    expect(consumeBoundaryPause()).toBe('pause');
  });

  it('spending a seat change keeps the pause the operator asked for', () => {
    requestBoundaryPause();
    requestSeatChangeAtBoundary();
    spendSeatChange();

    expect(stopStore.get().intent).toBe('pause-after-brief');
    expect(consumeBoundaryPause()).toBe('pause');
    expect(landBoundaryPause()).toBe('park');
  });

  it('keep running withdraws only the operator pause, and the seat change still waits', () => {
    requestBoundaryPause();
    requestSeatChangeAtBoundary();
    cancelBoundaryPause();

    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle', seatChange: true });
    expect(landBoundaryPause()).toBe('continue');
  });

  it('a seat change waits for the engine until it is spent', () => {
    expect(typeof seatChangeWaits).toBe('function');
    expect(seatChangeWaits()).toBe(false);

    requestSeatChangeAtBoundary();
    expect(seatChangeWaits()).toBe(true);
    expect(seatChangeWaits()).toBe(true);

    spendSeatChange();
    expect(seatChangeWaits()).toBe(false);
  });

  it('a pause of the user wins over a seat change that waits', () => {
    expect(typeof seatChangeWaits).toBe('function');
    requestBoundaryPause();
    requestSeatChangeAtBoundary();

    expect(seatChangeWaits()).toBe(false);
    expect(consumeBoundaryPause()).toBe('pause');
  });

  it('lands the boundary pause as a park, a continue on the saved seats, or a stop the operator asked for', () => {
    requestBoundaryPause();
    expect(landBoundaryPause()).toBe('park');

    stopStore.__testReset();
    requestSeatChangeAtBoundary();
    expect(landBoundaryPause()).toBe('continue');
    expect(stopStore.get().seatChange).toBe(false);

    requestBoundaryPause();
    requestSeatChangeAtBoundary();
    expect(landBoundaryPause()).toBe('stop');
    expect(stopStore.get()).toMatchObject({ intent: 'pause-after-brief', seatChange: false });
  });
});

describe('consumeBoundaryInterrupt', () => {
  beforeEach(() => {
    clearAllHandlers();
    lifecycleStore.reset();
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ status: 'running' });
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
