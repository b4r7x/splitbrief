import { describe, expect, it } from 'vitest';
import { consultAttemptError } from './consult-guidance.js';

describe('consultAttemptError', () => {
  it("appends the planner's guidance to the failed attempt's error", () => {
    expect(consultAttemptError({ lastError: 'tsc failed', instructions: 'Fix the import.' })).toBe(
      'tsc failed\n\n## Guidance from the planner:\nFix the import.',
    );
  });
});
