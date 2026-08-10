import { describe, expect, it } from 'vitest';
import { PHASES } from '../../../core/schemas/enums.js';
import { deriveLiveStatus } from './live-activity.js';

const base = {
  status: 'running' as const,
  cancelled: false,
  startedAt: 1000,
  phaseFirstSeenTs: {},
};

describe('deriveLiveStatus', () => {
  it('is null when idle, complete, cancelled, or at a review gate', () => {
    expect(deriveLiveStatus({ ...base, phase: 'idle' })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'complete' })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'researching', cancelled: true })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'reviewing-spec' })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'reviewing-plan' })).toBeNull();
    expect(deriveLiveStatus({ ...base, phase: 'reviewing-briefs' })).toBeNull();
  });

  it('deriveLiveStatus returns null unless the lifecycle is running', () => {
    expect(deriveLiveStatus({ ...base, phase: 'researching', status: 'interrupted' })).toBeNull();
  });

  it('deriveLiveStatus emits no spinner for paused', () => {
    expect(deriveLiveStatus({ ...base, phase: 'implementing', status: 'paused' })).toBeNull();
  });

  it.each([
    ['specifying', 'planner'],
    ['clarifying', 'planner'],
    ['constitution-check', 'planner'],
    ['planning', 'planner'],
    ['analyzing', 'planner'],
    ['validating-task', 'implementer'],
    ['escalating', 'implementer'],
    ['final-review', 'validator'],
  ] as const)('derives %s with the live %s byline tone', (phase, tone) => {
    expect(deriveLiveStatus({ ...base, phase })).toMatchObject({ tone });
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

  it('live verbs are Title Case', () => {
    const verbs = PHASES.flatMap((phase) => deriveLiveStatus({ ...base, phase })?.verb ?? []);
    expect(verbs.length).toBeGreaterThan(0);
    for (const verb of verbs) {
      expect(verb).toMatch(/^[A-Z]/);
    }
  });
});
