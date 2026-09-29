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
      availableActions: ['retry-same-worker', 'switch-seat', 'pause-run', 'end-run'],
      recommendedAction: 'switch-seat',
      switchSeat: { seat: 'build', candidates: [{ tool: 'codex' }, { tool: 'cursor' }] },
    });
    expect(formatResumeCommand('s1', issue)).toBe(
      'splitbrief continue s1 --action switch-seat:codex',
    );
  });

  // The recovery panel offers every action; `continue` opens it, so the line names the row there.
  it.each([
    ['pause-run', 'Pause run'],
    ['route-bigger-worker', 'Use a bigger worker'],
  ] as const)('opens the recovery panel on %s, in the words of its row', (action, label) => {
    const issue = makeRecoveryIssue({ recommendedAction: action });

    expect(formatResumeCommand('s1', issue)).toBe(
      `splitbrief continue s1, then choose ${label} in the recovery panel`,
    );
  });
});

describe('continuesHeadless', () => {
  it('runs headless only a line that names its action', () => {
    expect(continuesHeadless(skipIssue)).toBe(true);
    expect(continuesHeadless(makeRecoveryIssue({ recommendedAction: 'pause-run' }))).toBe(false);
  });
});
