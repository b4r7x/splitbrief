import { describe, expect, it } from 'vitest';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import { buildReviewInputTooLargeRecoveryIssue } from './review-input.js';

const createdAt = '2026-04-28T12:00:00.000Z';
const failure = {
  kind: 'input-too-large' as const,
  chars: 900_000,
  maxChars: 400_000,
  largestFiles: [{ path: 'src/big.ts', chars: 500_000 }],
};

describe('buildReviewInputTooLargeRecoveryIssue', () => {
  it.each([
    [true, ['accept-as-is', 'end-run']],
    [false, ['end-run']],
  ] as const)('with accept as is %s offers %j and recommends the end', (acceptAsIs, actions) => {
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: 'final-review',
      failure,
      tool: 'Codex',
      acceptAsIs,
      createdAt,
    });

    expect(issue.availableActions).toEqual(actions);
    expect(issue.recommendedAction).toBe('end-run');
    expect(issue.details.join(' ').includes('Skip the review with a note')).toBe(acceptAsIs);
    expect(RecoveryIssueSchema.safeParse(issue).success).toBe(true);
  });
});
