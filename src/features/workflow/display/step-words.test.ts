import { describe, it, expect } from 'vitest';
import { taskId } from '../../../core/schemas/task.js';
import { stepWord, stopPoint } from './step-words.js';

describe('stepWord', () => {
  it.each([
    [{ kind: 'planner', call: 'spec' } as const, 'the plan'],
    [{ kind: 'planner', call: 'plan' } as const, 'the plan'],
    [{ kind: 'gate', gate: 'briefs' } as const, 'the plan'],
    [{ kind: 'brief', taskId: taskId('T007'), attempt: 0 } as const, 'T007'],
    [{ kind: 'review', cycle: 1 } as const, 'the review'],
    [{ kind: 'apply' } as const, 'Apply'],
  ])('names %o as %s', (step, word) => {
    expect(stepWord(step)).toBe(word);
  });
});

describe('stopPoint', () => {
  it.each([
    [
      { kind: 'brief', taskId: taskId('T003'), attempt: 0 } as const,
      'boundary' as const,
      'before T003',
    ],
    [
      { kind: 'brief', taskId: taskId('T003'), attempt: 0 } as const,
      'mid-step' as const,
      'at T003',
    ],
    [{ kind: 'brief', taskId: taskId('T003'), attempt: 0 } as const, undefined, 'at T003'],
    [{ kind: 'review', cycle: 0 } as const, 'boundary' as const, 'before the review'],
    [{ kind: 'review', cycle: 0 } as const, 'mid-step' as const, 'at the review'],
    [{ kind: 'review', cycle: 0 } as const, undefined, 'at the review'],
    [{ kind: 'gate', gate: 'plan' } as const, 'boundary' as const, 'at the plan'],
    [{ kind: 'planner', call: 'plan' } as const, 'boundary' as const, 'at the plan'],
    [{ kind: 'apply' } as const, undefined, 'at Apply'],
  ])('phrases %o with cut %s as %s', (step, cut, expected) => {
    expect(stopPoint(step, cut)).toBe(expected);
  });
});
