import { beforeEach, describe, expect, it } from 'vitest';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { buildReviewFailedRecoveryIssue } from '../../../engine/orchestrator/recovery/builders/review-failed.js';
import { baseIssue, recoveryMenuText, usageLimitIssue } from '#testing/helpers/recovery-prompt.js';
import {
  correctionActionFor,
  parseRecoveryActionAnswer,
  RECOVERY_EMPTY_ENTER_NOTICE,
  recommendedRecoveryAction,
  recoveryComposerHint,
} from './actions.js';

it('sends a typed correction on a review its seat could not see to Try again', () => {
  const issue = buildReviewFailedRecoveryIssue({
    createdAt: '2026-04-29T12:00:00.000Z',
    blocking: 0,
    unverified: 2,
    reviewSeatNoImages: true,
    acceptAsIs: true,
    scope: 'final',
  });
  expect(correctionActionFor(issue, false)).toBe('retry-same-worker');
  expect(recoveryComposerHint(issue, true, false)).toBe(
    'Choose an action above, or tab to type a correction…',
  );
});

describe('recovery prompt', () => {
  beforeEach(() => {
    process.env.TERM = 'xterm-256color';
    process.env.LANG = 'en_US.UTF-8';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });

  it('reads the seat key whatever the offer holds, and no numbered key', () => {
    const issue = usageLimitIssue([{ tool: 'claude-code', model: 'sonnet' }, { tool: 'opencode' }]);

    expect(parseRecoveryActionAnswer('w', issue)).toBe('switch-seat');
    expect(parseRecoveryActionAnswer('w2', issue)).toBeNull();
    expect(parseRecoveryActionAnswer('w3', issue)).toBeNull();
  });

  it('parses answers into typed recovery actions', () => {
    expect(parseRecoveryActionAnswer('r', baseIssue)).toBe('retry-same-worker');
    expect(parseRecoveryActionAnswer('s', baseIssue)).toBe('skip-current-task');
    expect(parseRecoveryActionAnswer('a', baseIssue)).toBe('end-run');
  });

  it.each([
    'skip',
    'skip task',
    'end',
    'end run',
    'abort',
    'quit',
    'q',
    'restore',
    'later',
    'wait',
    'accept',
    'continue',
    'cont',
  ])('reads the word %s as no action', (word) => {
    const issue: RecoveryIssue = {
      ...baseIssue,
      availableActions: [
        'retry-same-worker',
        'restore-backup',
        'retry-later',
        'accept-as-is',
        'continue',
        'skip-current-task',
        'end-run',
      ],
    };

    expect(parseRecoveryActionAnswer(word, issue)).toBeNull();
  });

  it('marks the recommended action', () => {
    const issue: RecoveryIssue = { ...baseIssue, recommendedAction: 'skip-current-task' };

    expect(recommendedRecoveryAction(issue)).toBe('skip-current-task');
  });

  it('reads an empty answer as no action', () => {
    const issue: RecoveryIssue = { ...baseIssue, recommendedAction: 'skip-current-task' };

    expect(parseRecoveryActionAnswer('', issue)).toBeNull();
    expect(parseRecoveryActionAnswer('   ', issue)).toBeNull();
  });

  it('tells the user that an empty Enter sent nothing', () => {
    expect(RECOVERY_EMPTY_ENTER_NOTICE).toBe('Nothing to send. Tab to choose an action.');
    expect(recoveryComposerHint(baseIssue, false, false)).toBe(
      'Type a correction, or tab to choose an action…',
    );
    expect(
      recoveryComposerHint(
        {
          ...baseIssue,
          availableActions: ['skip-current-task', 'end-run'],
          recommendedAction: 'skip-current-task',
        },
        false,
        false,
      ),
    ).toBe('Tab to choose an action…');
  });

  it('returns null for unknown or unavailable non-empty input so the caller re-prompts', () => {
    expect(parseRecoveryActionAnswer('continue', baseIssue)).toBeNull();
    expect(parseRecoveryActionAnswer('w', baseIssue)).toBeNull();
    expect(parseRecoveryActionAnswer('nope', baseIssue)).toBeNull();
  });

  it('recommends the first listed action when the saved recommendation is not offered', () => {
    const issue: RecoveryIssue = {
      ...baseIssue,
      id: 'rec_unoffered',
      availableActions: ['skip-current-task', 'end-run'],
      recommendedAction: 'retry-same-worker',
    };

    expect(recommendedRecoveryAction(issue)).toBe('skip-current-task');
  });

  it('parses continue only when the issue allows it', () => {
    const issue: RecoveryIssue = {
      id: 'rec_no_progress',
      reason: 'no-progress',
      phase: 'implementing',
      status: 'awaiting-user',
      message: 'T003 is stuck on the same failure',
      files: [],
      affectedTaskIds: [],
      details: [],
      availableActions: ['continue', 'skip-current-task', 'end-run'],
      recommendedAction: 'continue',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    expect(parseRecoveryActionAnswer('c', issue)).toBe('continue');
    expect(parseRecoveryActionAnswer('c', { ...issue, availableActions: ['end-run'] })).toBeNull();
  });

  it('offers Decide for me as its own row and reads back only its key, never a typed word', () => {
    const issue: RecoveryIssue = {
      ...baseIssue,
      availableActions: ['decide-for-me', 'skip-current-task', 'end-run'],
      recommendedAction: 'skip-current-task',
    };

    expect(recoveryMenuText('decide-for-me', issue)).toBe('Decide for me');
    for (const answer of ['d', 'D']) {
      expect(parseRecoveryActionAnswer(answer, issue)).toBe('decide-for-me');
    }
    for (const answer of ['decide', 'decide for me', 'decide-for-me', '  Decide  ']) {
      expect(parseRecoveryActionAnswer(answer, issue)).toBeNull();
    }
    expect(
      parseRecoveryActionAnswer('d', {
        ...issue,
        availableActions: ['skip-current-task', 'end-run'],
      }),
    ).toBeNull();
  });

  it.each([
    ['v', 'revise'],
    ['revise', 'revise'],
    ['a', 'end-run'],
  ] as const)('parses %s as %s when the halt offers it', (answer, action) => {
    const issue: RecoveryIssue = {
      ...baseIssue,
      reason: 'plan-checks-failed',
      availableActions: ['revise', 'end-run'],
      recommendedAction: 'revise',
    };

    expect(parseRecoveryActionAnswer(answer, issue)).toBe(action);
  });

  it.each([
    [true, true, 'Choose an action above, or tab to type a correction…'],
    [true, false, 'Type a correction, or tab to choose an action…'],
    [false, true, 'Choose an action above…'],
    [false, false, 'Tab to choose an action…'],
  ] as const)(
    'names the focused side in the composer placeholder (correction %s, menu focused %s)',
    (takesCorrection, menuFocused, hint) => {
      const issue: RecoveryIssue = {
        ...baseIssue,
        availableActions: takesCorrection
          ? ['retry-same-worker', 'skip-current-task', 'end-run']
          : ['skip-current-task', 'end-run'],
      };

      expect(recoveryComposerHint(issue, menuFocused, false)).toBe(hint);
    },
  );

  it.each(['apply-partial', 'apply-conflict'] as const)(
    'invites no correction on an %s halt: Apply reads no typed words',
    (reason) => {
      const issue: RecoveryIssue = {
        ...baseIssue,
        reason,
        phase: 'complete',
        taskId: undefined,
        availableActions:
          reason === 'apply-partial'
            ? ['retry-same-worker', 'restore-backup']
            : ['retry-same-worker', 'end-run'],
        recommendedAction: 'retry-same-worker',
      };

      expect(correctionActionFor(issue, true)).toBeUndefined();
      expect(recoveryComposerHint(issue, false, true)).toBe('Tab to choose an action…');
      expect(recoveryComposerHint(issue, true, true)).toBe('Choose an action above…');
    },
  );

  it('invites no correction on a failed review when the step it resumes reads no words', () => {
    const issue: RecoveryIssue = {
      ...baseIssue,
      reason: 'review-failed',
      taskId: undefined,
      availableActions: ['revise', 'end-run'],
      recommendedAction: 'revise',
    };

    expect(correctionActionFor(issue, true)).toBeUndefined();
    expect(recoveryComposerHint(issue, false, true)).toBe('Tab to choose an action…');
    expect(recoveryComposerHint(issue, true, true)).toBe('Choose an action above…');
    expect(correctionActionFor(issue, false)).toBe('revise');
  });

  it('keeps Try again as the correction of a brief halt', () => {
    expect(correctionActionFor(baseIssue, false)).toBe('retry-same-worker');
  });
});
