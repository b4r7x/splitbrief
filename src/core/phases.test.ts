import { describe, it, expect } from 'vitest';
import { phaseTokenRole, phaseRole, canRedoTask } from './phases.js';
import { PHASES, type Phase } from './schemas/enums.js';
import { attributePhaseTokenDelta } from './state/token-attribution.js';
import type { TokenUsage } from './schemas/tokens.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const EMPTY_USAGE = makeUsage();

describe('phase roles', () => {
  it('keeps display roles and token roles explicit for final review', () => {
    expect(phaseRole('final-review')).toBe('planner');
    expect(phaseTokenRole('final-review')).toBe('implementer');
  });

  it('classifies planner and implementer token phases centrally', () => {
    expect(phaseTokenRole('planning')).toBe('planner');
    expect(phaseTokenRole('implementing')).toBe('implementer');
    expect(phaseTokenRole('idle')).toBeNull();
  });

  it('attributes the speckit analyze call to the planner per-phase bucket', () => {
    expect(phaseTokenRole('analyzing')).toBe('planner');

    const curr: TokenUsage = { ...EMPTY_USAGE, plannerInput: 800, plannerOutput: 200 };
    const attribution = attributePhaseTokenDelta({
      previous: EMPTY_USAGE,
      current: curr,
      phase: 'analyzing',
    });

    expect(attribution.planner).toEqual({
      input: 800,
      output: 200,
      cacheRead: 0,
      cacheCreate: 0,
    });
    expect(attribution.implementer).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
    });
  });
});

const CAN_REDO_TASK: { allowed: Phase[]; denied: Phase[] } = {
  allowed: ['implementing', 'validating-task', 'escalating'],
  denied: [
    'idle',
    'researching',
    'specifying',
    'reviewing-spec',
    'clarifying',
    'constitution-check',
    'planning',
    'reviewing-plan',
    'reviewing-briefs',
    'analyzing',
    'final-review',
    'complete',
  ],
};

describe('phase guard coverage', () => {
  describe('canRedoTask', () => {
    it.each(CAN_REDO_TASK.allowed)('returns true for %s', (phase) => {
      expect(canRedoTask(phase)).toBe(true);
    });
    it.each(CAN_REDO_TASK.denied)('returns false for %s', (phase) => {
      expect(canRedoTask(phase)).toBe(false);
    });
    it('covers all phases', () => {
      expect([...CAN_REDO_TASK.allowed, ...CAN_REDO_TASK.denied].sort()).toEqual(
        [...PHASES].sort(),
      );
    });
  });
});
