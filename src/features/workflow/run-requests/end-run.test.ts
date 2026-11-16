import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
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

  it('ends nothing at rest when the project folder exists and holds no saved state', () => {
    const projectDir = createTempDir('end-run-no-state');
    onTestFinished(() => {
      routerStore.init({ screen: 'home' });
      cleanupTempDir(projectDir);
    });
    feedbackStore.reset();
    routerStore.init({
      screen: 'workflow',
      run: makeRunRecord({ ref: { projectDir, sessionId: '2026-09-14-no-state' } }),
      execution: { kind: 'at-rest' },
    });

    expect(requestEndRun()).toBe(false);
    expect(feedbackStore.get().message).toBeNull();
    expect(stopStore.get().intent).toBe('none');
  });
});
