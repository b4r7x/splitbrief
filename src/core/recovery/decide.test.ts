import { describe, expect, it } from 'vitest';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import { DECIDE_YOURSELF_ANSWER, decidedRecovery } from './decide.js';

const briefHalt: RecoveryIssue = {
  id: 'rec_test',
  reason: 'retry-exhausted',
  phase: 'escalating',
  status: 'awaiting-user',
  files: [],
  affectedTaskIds: [],
  message: 'T003 failed',
  details: [],
  availableActions: [
    'retry-same-worker',
    'skip-current-task',
    'end-run',
    'restore-backup',
    'decide-for-me',
  ],
  recommendedAction: 'skip-current-task',
  createdAt: '2026-10-29T10:00:00.000Z',
};

describe('decidedRecovery', () => {
  it('skips a brief the planner cannot do, or ends the run when the planner named that', () => {
    expect(
      decidedRecovery({ ...briefHalt, facts: { cannot: 'The SDK has no payment API.' } }),
    ).toEqual({ action: 'skip-current-task' });
    expect(
      decidedRecovery({
        ...briefHalt,
        facts: { cannot: 'The SDK has no payment API.', cannotNext: 'end-run' },
      }),
    ).toEqual({ action: 'end-run' });
  });

  it('leaves an unanswered question to the planner', () => {
    expect(decidedRecovery({ ...briefHalt, facts: { question: 'Which API version?' } })).toEqual({
      action: 'retry-same-worker',
      answer: DECIDE_YOURSELF_ANSWER,
    });
  });

  it('ends the run on a failed review the planner cannot fix', () => {
    const review: RecoveryIssue = {
      ...briefHalt,
      reason: 'review-failed',
      phase: 'final-review',
      facts: { cannot: 'The blockers need a design change.' },
      availableActions: ['revise', 'decide-for-me', 'end-run'],
      recommendedAction: 'revise',
    };
    expect(decidedRecovery(review)).toEqual({ action: 'end-run' });
    expect(decidedRecovery({ ...review, facts: {} })).toBeUndefined();
  });

  it('sends a review question nobody answered back to the next review', () => {
    expect(
      decidedRecovery({
        ...briefHalt,
        reason: 'review-failed',
        phase: 'final-review',
        facts: { question: 'Is V1 the right gate command?' },
        availableActions: ['revise', 'decide-for-me', 'end-run'],
        recommendedAction: 'revise',
      }),
    ).toEqual({ action: 'revise' });
  });

  it('waits for the reset of a seat down with no fallback, and not when the seat switches itself', () => {
    const seatDown: RecoveryIssue = {
      ...briefHalt,
      reason: 'runner-usage-limit',
      seat: 'build',
      availableActions: ['retry-later', 'switch-seat', 'end-run'],
      recommendedAction: 'retry-later',
    };
    expect(decidedRecovery(seatDown)).toEqual({ action: 'retry-later' });
    expect(
      decidedRecovery({
        ...seatDown,
        switchSeat: {
          seat: 'build',
          candidates: [{ tool: 'codex' }],
          auto: { candidate: { tool: 'codex' }, configRevision: 'r1' },
        },
      }),
    ).toBeUndefined();
  });

  it('decides nothing the halt does not offer, and leaves the user every other halt', () => {
    expect(
      decidedRecovery({
        ...briefHalt,
        reason: 'runner-unauthenticated',
        availableActions: ['switch-seat', 'end-run'],
        recommendedAction: 'switch-seat',
      }),
    ).toBeUndefined();
    expect(decidedRecovery({ ...briefHalt, facts: {} })).toBeUndefined();
    expect(
      decidedRecovery({
        ...briefHalt,
        reason: 'apply-conflict',
        availableActions: ['end-run'],
        recommendedAction: 'end-run',
      }),
    ).toBeUndefined();
  });
});
