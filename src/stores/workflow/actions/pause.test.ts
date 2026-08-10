import { beforeEach, describe, expect, it } from 'vitest';
import { addEvent } from './event.js';
import { markWorkflowPaused } from './pause.js';
import { resetWorkflow } from './reset.js';
import { lifecycleStore } from '../lifecycle.js';

describe('markWorkflowPaused', () => {
  beforeEach(() => resetWorkflow());

  it("pause-run sets lifecycle status 'paused'", () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });

    markWorkflowPaused();

    expect(lifecycleStore.get()).toMatchObject({
      status: 'paused',
      phase: 'implementing',
      cancelled: false,
    });
  });
});
