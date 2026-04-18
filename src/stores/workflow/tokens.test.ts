import { describe, it, expect, beforeEach } from 'vitest';
import { tokensStore } from './tokens.js';
import { addEvent, resetWorkflow } from './actions.js';
import {
  makeTaskComplete,
  makeCostUpdate,
} from '#testing/helpers/events.js';

describe('tokensStore — cost-update', () => {
  beforeEach(() => resetWorkflow());

  it('sets tokenUsage from cost-update event', () => {
    const event = makeCostUpdate();
    addEvent(event);
    expect(tokensStore.get().tokenUsage).toEqual(event.tokenUsage);
  });

  it('overwrites previous tokenUsage', () => {
    addEvent(makeCostUpdate());
    const updated = { plannerInput: 999, plannerOutput: 999, implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 };
    addEvent(makeCostUpdate({ tokenUsage: updated }));
    expect(tokensStore.get().tokenUsage).toEqual(updated);
  });
});

describe('tokensStore — task-complete counters', () => {
  beforeEach(() => resetWorkflow());

  it('increments localCount on task-complete with method=local', () => {
    tokensStore.__testReset({ localCount: 1 });
    addEvent(makeTaskComplete({ method: 'local' }));
    expect(tokensStore.get().localCount).toBe(2);
  });

  it('increments escalatedCount on task-complete with method=escalated-hint', () => {
    addEvent(makeTaskComplete({ method: 'escalated-hint' }));
    expect(tokensStore.get().escalatedCount).toBe(1);
  });

  it('increments escalatedCount on task-complete with method=escalated-full', () => {
    addEvent(makeTaskComplete({ method: 'escalated-full' }));
    expect(tokensStore.get().escalatedCount).toBe(1);
  });

  it('does not increment any counter for method=failed', () => {
    addEvent(makeTaskComplete({ method: 'failed' }));
    const s = tokensStore.get();
    expect(s.localCount).toBe(0);
    expect(s.escalatedCount).toBe(0);
  });

  it('does not increment any counter for method=skipped', () => {
    addEvent(makeTaskComplete({ method: 'skipped' }));
    const s = tokensStore.get();
    expect(s.localCount).toBe(0);
    expect(s.escalatedCount).toBe(0);
  });
});
