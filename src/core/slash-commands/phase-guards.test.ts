import { describe, it, expect } from 'vitest';
import type { Phase } from '../types/state-actions.js';
import { PHASES } from '../types/schemas/enums.js';
import { canReviseSpec, canRevisePlan, canRedoTask, phaseOrder } from './phase-guards.js';

describe('phaseOrder', () => {
  it('returns index in PHASES array', () => {
    expect(phaseOrder('idle')).toBe(0);
    expect(phaseOrder('researching')).toBe(1);
    expect(phaseOrder('implementing')).toBe(6);
    expect(phaseOrder('complete')).toBe(PHASES.length - 1);
  });

  it('maintains ascending order for all phases', () => {
    for (let i = 1; i < PHASES.length; i++) {
      expect(phaseOrder(PHASES[i]!)).toBeGreaterThan(phaseOrder(PHASES[i - 1]!));
    }
  });
});

describe('canReviseSpec', () => {
  const allowed: Phase[] = ['reviewing-spec', 'planning', 'reviewing-plan', 'implementing', 'validating-task', 'escalating', 'final-review'];
  const denied: Phase[] = ['idle', 'researching', 'specifying', 'complete'];

  it.each(allowed)('returns true for %s', (phase) => {
    expect(canReviseSpec(phase)).toBe(true);
  });

  it.each(denied)('returns false for %s', (phase) => {
    expect(canReviseSpec(phase)).toBe(false);
  });

  it('covers all phases', () => {
    expect([...allowed, ...denied].sort()).toEqual([...PHASES].sort());
  });
});

describe('canRevisePlan', () => {
  const allowed: Phase[] = ['reviewing-plan', 'implementing', 'validating-task', 'escalating', 'final-review'];
  const denied: Phase[] = ['idle', 'researching', 'specifying', 'reviewing-spec', 'planning', 'complete'];

  it.each(allowed)('returns true for %s', (phase) => {
    expect(canRevisePlan(phase)).toBe(true);
  });

  it.each(denied)('returns false for %s', (phase) => {
    expect(canRevisePlan(phase)).toBe(false);
  });

  it('covers all phases', () => {
    expect([...allowed, ...denied].sort()).toEqual([...PHASES].sort());
  });
});

describe('canRedoTask', () => {
  const allowed: Phase[] = ['implementing', 'validating-task', 'escalating'];
  const denied: Phase[] = ['idle', 'researching', 'specifying', 'reviewing-spec', 'planning', 'reviewing-plan', 'final-review', 'complete'];

  it.each(allowed)('returns true for %s', (phase) => {
    expect(canRedoTask(phase)).toBe(true);
  });

  it.each(denied)('returns false for %s', (phase) => {
    expect(canRedoTask(phase)).toBe(false);
  });

  it('covers all phases', () => {
    expect([...allowed, ...denied].sort()).toEqual([...PHASES].sort());
  });
});
