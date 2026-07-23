import { describe, it, expect } from 'vitest';
import { buildTaskRows, formatTotalTokens } from './task-breakdown.js';

describe('buildTaskRows', () => {
  it('returns empty array for empty perTask', () => {
    expect(buildTaskRows({})).toEqual([]);
  });

  it('sorts by totalTokens descending', () => {
    const rows = buildTaskRows({
      task1: { totalTokens: 200, title: 'First task' },
      task2: { totalTokens: 800, title: 'Second task' },
      task3: { totalTokens: 50, title: 'Third task' },
    });
    expect(rows.map((r) => r.taskId)).toEqual(['task2', 'task1', 'task3']);
  });
});

describe('formatTotalTokens', () => {
  it.each([
    [500, '500 tok'],
    [2500, '2.5k tok'],
  ] as const)('formatTotalTokens(%i) → %s', (tokens, expected) => {
    expect(formatTotalTokens(tokens)).toBe(expected);
  });
});
