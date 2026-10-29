import { describe, expect, it } from 'vitest';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import { buildReviewInputTooLargeRecoveryIssue } from './review-input.js';

const createdAt = '2026-04-28T12:00:00.000Z';
const failure = {
  kind: 'input-too-large' as const,
  figures: { unit: 'characters' as const, size: 1_100_000, limit: 1_048_576 },
  promptSize: { characters: 1_100_000 },
  changeFile: '.splitbrief/reviews/run-1.diff',
  workspaceDir: '/work',
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

  it('names the size and the limit', () => {
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: 'final-review',
      failure: { ...failure, figures: { unit: 'characters', size: 1_150_000, limit: 1_000_000 } },
      tool: 'Custom reviewer',
      acceptAsIs: true,
      createdAt,
    });

    expect(issue.message).toBe(
      'Review input is 1,150,000 characters; Custom reviewer takes at most 1,000,000',
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

  it('names the change file the seat reads in the run workspace, not diffs, after the choices', () => {
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: 'final-review',
      failure,
      tool: 'Codex',
      acceptAsIs: true,
      createdAt,
    });

    expect(issue.details[0]).toMatch(/^A retry sends the same input\./);
    expect(issue.details[1]).toBe(
      'The reviewer reads the change from .splitbrief/reviews/run-1.diff in the run workspace, not from the prompt; the prompt holds the plan, the briefs and the evidence.',
    );
    expect(issue.facts?.changeFile).toBe('/work/.splitbrief/reviews/run-1.diff');
  });

  it('says the change can fill the context of a tool that refused with no cap', () => {
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: 'final-review',
      failure: { ...failure, figures: { unit: 'characters', size: null, limit: null } },
      tool: 'Claude Code',
      acceptAsIs: true,
      createdAt,
    });

    expect(issue.details[1]).toBe(
      'The reviewer reads the change from .splitbrief/reviews/run-1.diff in the run workspace, not from the prompt; the prompt holds the plan, the briefs and the evidence. A very large change can also fill the context of Claude Code when it reads that file.',
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
    expect(issue.details[0]).toBe(
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
