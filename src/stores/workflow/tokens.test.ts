import { describe, it, expect, beforeEach } from 'vitest';
import { tokensStore } from './tokens.js';
import { addEvent, resetWorkflow } from './actions.js';
import {
  makeTaskComplete,
  makeCostUpdate,
} from '#testing/helpers/events.js';

describe('tokensStore — cost-update', () => {
  beforeEach(() => resetWorkflow());

  it('sets tokenUsage and overwrites on subsequent cost-update', () => {
    const first = makeCostUpdate();
    addEvent(first);
    expect(tokensStore.get().tokenUsage).toEqual(first.tokenUsage);

    const updated = { plannerInput: 999, plannerOutput: 999, implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 };
    addEvent(makeCostUpdate({ tokenUsage: updated }));
    expect(tokensStore.get().tokenUsage).toEqual(updated);
  });
});

describe('tokensStore — task-complete counters', () => {
  beforeEach(() => resetWorkflow());

  it.each([
    { method: 'local' as const, localCount: 1, escalatedCount: 0 },
    { method: 'escalated-hint' as const, localCount: 0, escalatedCount: 1 },
    { method: 'escalated-full' as const, localCount: 0, escalatedCount: 1 },
    { method: 'failed' as const, localCount: 0, escalatedCount: 0 },
    { method: 'skipped' as const, localCount: 0, escalatedCount: 0 },
  ])('method=$method → local=$localCount, escalated=$escalatedCount', ({ method, localCount, escalatedCount }) => {
    addEvent(makeTaskComplete({ method }));
    const s = tokensStore.get();
    expect(s.localCount).toBe(localCount);
    expect(s.escalatedCount).toBe(escalatedCount);
  });
});
