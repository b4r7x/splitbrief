import { describe, it, expect } from 'vitest';
import { isQueuePhase, phaseTokenRole, phaseRole } from './roles.js';
import { attributePhaseTokenDelta } from '../state/token-attribution.js';
import type { TokenUsage } from '../schemas/tokens.js';
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

describe('isQueuePhase', () => {
  it.each(['researching', 'specifying', 'planning', 'final-review'] as const)(
    'queues composer words for the live call in %s',
    (phase) => {
      expect(isQueuePhase(phase)).toBe(true);
    },
  );

  it.each(['implementing', 'validating-task', 'escalating'] as const)(
    'queues composer words for the brief in BUILD in %s',
    (phase) => {
      expect(isQueuePhase(phase)).toBe(true);
    },
  );

  it.each([
    'idle',
    'clarifying',
    'reviewing-spec',
    'reviewing-plan',
    'reviewing-briefs',
    'complete',
  ] as const)('takes no queued words in %s', (phase) => {
    expect(isQueuePhase(phase)).toBe(false);
  });
});
