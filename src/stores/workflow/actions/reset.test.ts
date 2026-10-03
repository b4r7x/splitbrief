import { describe, it, expect, beforeEach } from 'vitest';
import { addEvent } from './event.js';
import { resetWorkflow } from './reset.js';
import { eventsStore } from '../events.js';
import { tasksStore } from '../tasks.js';
import { tokensStore } from '../tokens.js';
import { lifecycleStore } from '../lifecycle.js';
import { stopStore } from '../stop.js';
import { approvalPromptStore, openApprovalPrompt } from '../../approval-prompt/prompt.js';
import { makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeTaskStart, makeTaskComplete } from '#testing/helpers/events/task.js';

describe('resetWorkflow', () => {
  beforeEach(() => resetWorkflow());

  it('closes a pending tiered approval prompt with the cancelled decision', async () => {
    const pending = openApprovalPrompt({
      tier: 'confirm',
      actionClass: 'network',
      actionDescription: 'push to origin',
      phase: 'implementing',
    });
    expect(approvalPromptStore.get().status).toBe('pending');

    resetWorkflow();

    expect(approvalPromptStore.get().status).toBe('idle');
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
  });

  it('clears a stop request before resetting sub-stores', () => {
    stopStore.request('stop-now');
    expect(stopStore.get().phase).toBe('requested');
    resetWorkflow();
    expect(stopStore.get()).toMatchObject({ intent: 'none', phase: 'idle' });
  });

  it('resets workflow sub-stores to initial state', () => {
    addEvent(makeTaskStart({ index: 1, total: 3 }));
    addEvent(makePlannerStatus({ phase: 'implementing', status: 'running' }));
    addEvent({
      type: 'runner_call_tool_use',
      ts: Date.now(),
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 1,
      stage: 'delta',
      name: 'Bash',
      inputDelta: '{"command":"npm run typecheck"}',
    });
    addEvent(makeTaskComplete({ method: 'local' }));

    resetWorkflow();

    expect(eventsStore.get().events).toEqual([]);
    expect(tasksStore.get().currentTask).toBe(0);
    expect(tasksStore.get().totalTasks).toBe(0);
    expect(tokensStore.get().localCount).toBe(0);
    expect(lifecycleStore.get().phase).toBe('idle');
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
  });
});
