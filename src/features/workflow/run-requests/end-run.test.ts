import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllHandlers, setCancelHandler } from './registry.js';
import { requestEndRun } from './end-run.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { eventsStore } from '../../../stores/workflow/events/state.js';
import { stopStore } from '../../../stores/workflow/stop.js';

describe('requestEndRun', () => {
  beforeEach(() => {
    clearAllHandlers();
    stopStore.__testReset();
    lifecycleStore.reset();
    eventsStore.reset();
    runViewStore.__testReset({ phase: 'planning' });
    lifecycleStore.__testReset({ status: 'running' });
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
