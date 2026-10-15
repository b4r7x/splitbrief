import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { continuesHeadless, formatResumeCommand } from './resume-command.js';

const skipIssue = makeRecoveryIssue({ recommendedAction: 'skip-current-task' });

describe('formatResumeCommand', () => {
  it('names the skip action the CLI accepts', () => {
    expect(formatResumeCommand('s1', skipIssue)).toBe('splitbrief continue s1 --action skip');
  });

  it('names the retry action', () => {
    expect(
      formatResumeCommand('s1', makeRecoveryIssue({ recommendedAction: 'retry-same-worker' })),
    ).toBe('splitbrief continue s1 --action retry');
  });

  it('names the end-run action', () => {
    expect(formatResumeCommand('s1', makeRecoveryIssue({ recommendedAction: 'end-run' }))).toBe(
      'splitbrief continue s1 --action end-run',
    );
  });

  it('carries the first swap candidate for a seat switch', () => {
    const issue = makeRecoveryIssue({
      reason: 'runner-usage-limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'codex' }, { tool: 'cursor' }] },
    });
    expect(formatResumeCommand('s1', issue)).toBe(
      'splitbrief continue s1 --action switch-seat:codex',
    );
  });

  it('spells the candidate model and effort the parser reads back', () => {
    const issue = makeRecoveryIssue({
      reason: 'runner-usage-limit',
      availableActions: ['switch-seat', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: {
        seat: 'build',
        candidates: [{ tool: 'opencode', model: 'opencode-go/kimi-k3', effort: 'high' }],
      },
    });
    expect(formatResumeCommand('s1', issue)).toBe(
      'splitbrief continue s1 --action switch-seat:opencode:opencode-go/kimi-k3@high',
    );
  });

  it('spells a variant candidate with its variant word', () => {
    const issue = makeRecoveryIssue({
      reason: 'runner-usage-limit',
      availableActions: ['switch-seat', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: {
        seat: 'build',
        candidates: [{ tool: 'opencode', model: 'opencode-go/kimi-k3', variant: 'high' }],
      },
    });
    expect(formatResumeCommand('s1', issue)).toBe(
      'splitbrief continue s1 --action switch-seat:opencode:opencode-go/kimi-k3@high',
    );
  });

  // The recovery panel offers every action; `continue` opens it, so the line names the row there.
  it.each([
    ['consult-bound-spent', 'continue', 'Continue'],
    ['plan-checks-failed', 'revise', 'Send a correction'],
    ['review-failed', 'revise', 'Fix again'],
    ['review-input-too-large', 'accept-as-is', 'Skip review with a note'],
    ['apply-partial', 'restore-backup', 'Restore backup'],
  ] as const)(
    'opens the recovery panel on a %s halt recommending %s, in the words of its row',
    (reason, action, label) => {
      const issue = makeRecoveryIssue({
        reason,
        availableActions: [action, 'end-run'],
        recommendedAction: action,
      });

      expect(formatResumeCommand('s1', issue)).toBe(
        `splitbrief continue s1, then choose ${label} in the recovery panel`,
      );
    },
  );
});

describe('continuesHeadless', () => {
  it('runs headless only a line that names its action', () => {
    expect(continuesHeadless(skipIssue)).toBe(true);
    expect(
      continuesHeadless(
        makeRecoveryIssue({
          reason: 'consult-bound-spent',
          availableActions: ['continue', 'end-run'],
          recommendedAction: 'continue',
        }),
      ),
    ).toBe(false);
  });
});
