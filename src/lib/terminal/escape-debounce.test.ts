import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  scheduleEscapeAction,
  cancelEscapeAction,
  isEscapeActionPending,
} from './escape-debounce.js';

describe('escape-debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cancelEscapeAction();
  });

  afterEach(() => {
    cancelEscapeAction();
    vi.useRealTimers();
  });

  it('fires the action after the default 35ms delay', () => {
    const action = vi.fn();
    scheduleEscapeAction(action);
    expect(isEscapeActionPending()).toBe(true);
    expect(action).not.toHaveBeenCalled();

    vi.advanceTimersByTime(34);
    expect(action).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect(isEscapeActionPending()).toBe(false);
  });

  it('cancel prevents a pending action from firing', () => {
    const action = vi.fn();
    scheduleEscapeAction(action);
    expect(isEscapeActionPending()).toBe(true);

    cancelEscapeAction();
    expect(isEscapeActionPending()).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(action).not.toHaveBeenCalled();
  });

  it('scheduling again replaces the pending action and restarts the timer', () => {
    const first = vi.fn();
    const second = vi.fn();

    scheduleEscapeAction(first);
    vi.advanceTimersByTime(20);
    scheduleEscapeAction(second);

    // The first action's original deadline passes without it firing.
    vi.advanceTimersByTime(20);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('reports not pending after the action fires', () => {
    scheduleEscapeAction(() => {});
    vi.advanceTimersByTime(35);
    expect(isEscapeActionPending()).toBe(false);
  });
});
