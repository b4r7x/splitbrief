import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { formatResumeCommand } from './resume-command.js';

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

  it('carries the first swap candidate for a seat switch', () => {
    const issue = makeRecoveryIssue({
      reason: 'runner-usage-limit',
      availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'abort-workflow'],
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'codex' }, { tool: 'cursor' }] },
    });
    expect(formatResumeCommand('s1', issue)).toBe(
      'splitbrief continue s1 --action switch-seat:codex',
    );
  });

  it('resumes and points at the TUI for an action the CLI cannot take', () => {
    expect(
      formatResumeCommand('s1', makeRecoveryIssue({ recommendedAction: 'route-bigger-worker' })),
    ).toBe('splitbrief resume (route-bigger-worker is available in the TUI)');
  });
});
