import { describe, expect, it } from 'vitest';
import { consultAttemptError } from './consult-guidance.js';

describe('consultAttemptError', () => {
  it.each([
    ['plan', '## Guidance from the planner:'],
    ['review', '## Guidance from the reviewer:'],
  ] as const)('heads the %s seat guidance with the runner that answered', (seat, heading) => {
    expect(consultAttemptError('tsc failed', 'Fix the import.', seat)).toBe(
      `tsc failed\n\n${heading}\nFix the import.`,
    );
  });
});
