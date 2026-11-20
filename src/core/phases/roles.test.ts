import { describe, it, expect } from 'vitest';
import { isQueuePhase, phaseRole } from './roles.js';

describe('phase roles', () => {
  it('keeps display roles explicit for final review', () => {
    expect(phaseRole('final-review')).toBe('planner');
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
