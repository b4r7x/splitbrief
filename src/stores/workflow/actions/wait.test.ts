import { beforeEach, describe, expect, it } from 'vitest';
import { addEvent } from './event.js';
import { resetWorkflow } from './reset.js';
import { markWaitEnded, markWaitStarted } from './wait.js';
import { lifecycleStore } from '../lifecycle.js';

describe('markWaitStarted / markWaitEnded', () => {
  beforeEach(() => resetWorkflow());

  it('books the time the run waited on the user against the phase it waited in', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });

    markWaitStarted(2_000);
    expect(lifecycleStore.get().waitingSince).toBe(2_000);

    markWaitEnded(5_000);
    expect(lifecycleStore.get()).toMatchObject({
      waitingSince: null,
      waitedMs: { researching: 3_000 },
    });
  });

  it('is a no-op on a run that is not running and when no wait is open', () => {
    const idle = lifecycleStore.get();
    markWaitStarted(2_000);
    expect(lifecycleStore.get()).toBe(idle);

    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    const running = lifecycleStore.get();
    markWaitEnded(5_000);
    expect(lifecycleStore.get()).toBe(running);
  });
});
