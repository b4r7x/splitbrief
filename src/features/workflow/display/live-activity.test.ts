import { describe, expect, it } from 'vitest';
import { deriveLiveStatus } from './live-activity.js';

const base = { cancelled: false, startedAt: 1000, phaseFirstSeenTs: {} };

describe('deriveLiveStatus', () => {
  it('is null when idle, complete, cancelled, or at a review gate', () => {
    expect(deriveLiveStatus({ ...base, phase: 'idle' })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'complete' })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'researching', cancelled: true })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'reviewing-spec' })).toBeNull();
  });

  it('carries the verb, the stage start, and the role tone for a live planner stage', () => {
    const status = deriveLiveStatus({ ...base, phase: 'researching' });
    expect(status).toEqual({ verb: 'Researching…', stageStart: 1000, tone: 'planner' });
  });

  it('uses the implementer tone during build and derives stage start from phaseFirstSeenTs', () => {
    const status = deriveLiveStatus({
      ...base,
      phase: 'implementing',
      phaseFirstSeenTs: { implementing: 5000 },
    });
    expect(status?.tone).toBe('implementer');
    expect(status?.stageStart).toBe(5000);
  });
});
