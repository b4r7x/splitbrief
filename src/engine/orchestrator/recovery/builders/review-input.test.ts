import { describe, expect, it } from 'vitest';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import { buildReviewInputTooLargeRecoveryIssue } from './review-input.js';

const createdAt = '2026-04-28T12:00:00.000Z';
const failure = {
  kind: 'input-too-large' as const,
  figures: { unit: 'characters' as const, size: 1_100_000, limit: 1_048_576 },
  promptSize: { characters: 1_100_000, bytes: 1_150_000 },
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

  it('names the size and the limit in the unit the limit counts', () => {
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: 'final-review',
      failure: { ...failure, figures: { unit: 'bytes', size: 1_150_000, limit: 1_000_000 } },
      tool: 'Custom reviewer',
      acceptAsIs: true,
      createdAt,
    });

    expect(issue.message).toBe(
      'Review input is 1,150,000 bytes; Custom reviewer takes at most 1,000,000 on its command line',
    );
  });

  it('says the tool refused it when the refusal names no limit', () => {
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: 'final-review',
      failure: { ...failure, figures: { unit: 'characters', size: 1_100_000, limit: null } },
      tool: 'Claude Code',
      acceptAsIs: true,
      createdAt,
    });

    expect(issue.message).toBe(
      'Review input is 1,100,000 characters; Claude Code refused it as too large',
    );
  });

  it('offers and recommends the tools that take the prompt, keeping skip and end', () => {
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: 'final-review',
      failure,
      tool: 'Codex',
      acceptAsIs: true,
      seatSwap: {
        seat: 'review',
        currentTool: 'codex',
        detectedTools: [
          { tool: 'codex', model: 'gpt-5', ready: true },
          { tool: 'opencode', ready: true },
          { tool: 'claude-code', ready: false },
        ],
      },
      createdAt,
    });

    expect(issue.availableActions).toEqual(['switch-seat', 'accept-as-is', 'end-run']);
    expect(issue.recommendedAction).toBe('switch-seat');
    expect(issue.switchSeat).toEqual({ seat: 'review', candidates: [{ tool: 'opencode' }] });
    expect(issue.details[1]).toBe(
      'A retry sends the same input. Change the REVIEW tool to one that takes it, Skip the review with a note (recorded, not a verification) or End the run (a workspace run saves its changes in run.patch).',
    );
    expect(RecoveryIssueSchema.safeParse(issue).success).toBe(true);
  });

  it('offers no seat change when no ready tool takes the prompt', () => {
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: 'final-review',
      failure,
      tool: 'Codex',
      acceptAsIs: true,
      seatSwap: {
        seat: 'review',
        currentTool: 'claude-code',
        detectedTools: [{ tool: 'codex', ready: true }],
      },
      createdAt,
    });

    expect(issue.availableActions).toEqual(['accept-as-is', 'end-run']);
    expect(issue.recommendedAction).toBe('end-run');
    expect(issue.switchSeat).toBeUndefined();
  });
});
