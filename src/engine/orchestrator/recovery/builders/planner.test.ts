import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import type { SeatSwapContext } from './task.js';
import {
  buildPlannerCallFailedRecoveryIssue,
  buildPlanSessionHaltRecoveryIssue,
} from './planner.js';

const createdAt = '2026-04-28T12:00:00.000Z';
const plannerRunner = makeConfig({ planner: { kind: 'cli', tool: 'codex' } }).planner;

function expectValidRecoveryIssue(issue: unknown): void {
  const result = RecoveryIssueSchema.safeParse(issue);
  expect(result.success).toBe(true);
}

const plannerSeatSwap: SeatSwapContext = {
  seat: 'plan',
  currentTool: 'codex',
  detectedTools: [
    { tool: 'claude-code', ready: true },
    { tool: 'codex', ready: true },
    { tool: 'opencode', ready: false },
  ],
};

describe('buildPlannerCallFailedRecoveryIssue', () => {
  it('offers a re-issue and an end, and no task actions', () => {
    const issue = buildPlannerCallFailedRecoveryIssue({
      diagnosis: { failure: 'call-failed', message: 'Planning failed.' },
      phase: 'planning',
      runner: plannerRunner,
      createdAt,
    });

    expect(issue.reason).toBe('planner-call-failed');
    expect(issue.seat).toBe('plan');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.taskId).toBeUndefined();
    expectValidRecoveryIssue(issue);
  });

  it('adds the seat swap only when another ready tool was detected', () => {
    const issue = buildPlannerCallFailedRecoveryIssue({
      diagnosis: { failure: 'call-failed', message: 'Planning failed.' },
      phase: 'planning',
      runner: plannerRunner,
      seatSwap: plannerSeatSwap,
      createdAt,
    });

    expect(issue.switchSeat).toEqual({
      seat: 'plan',
      candidates: [{ tool: 'claude-code' }],
    });
    expect(issue.availableActions).toEqual(['retry-same-worker', 'switch-seat', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });

  it('builds the one seat-down halt for a quota halt and a sign-out', () => {
    const limit = buildPlannerCallFailedRecoveryIssue({
      diagnosis: {
        failure: 'usage-limit',
        message: 'OpenAI Codex CLI hit its usage limit.',
        tool: 'OpenAI Codex CLI',
        resetsAt: new Date('2026-08-08T15:27:00.000Z'),
        seatDown: {
          classification: { class: 'rate-limited', resetAt: new Date('2026-08-08T15:27:00.000Z') },
          words: "You've hit your usage limit.",
        },
      },
      phase: 'planning',
      runner: plannerRunner,
      seatSwap: plannerSeatSwap,
      createdAt,
    });
    const signedOut = buildPlannerCallFailedRecoveryIssue({
      diagnosis: {
        failure: 'unauthenticated',
        message: 'OpenAI Codex CLI is signed out.',
        tool: 'OpenAI Codex CLI',
        seatDown: { classification: { class: 'account', cause: 'auth' }, words: 'HTTP 403' },
      },
      phase: 'planning',
      runner: plannerRunner,
      seatSwap: plannerSeatSwap,
      createdAt,
    });

    expect(limit.reason).toBe('runner-usage-limit');
    expect(limit.resetAt).toBe('2026-08-08T15:27:00.000Z');
    expect(limit.facts?.tool).toBe('OpenAI Codex CLI');
    expect(limit.facts?.cause).toBe('rate-limit');
    expect(limit.recommendedAction).toBe('switch-seat');
    expect(limit.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'retry-later',
      'end-run',
    ]);
    expect(signedOut.reason).toBe('runner-unauthenticated');
    expect(signedOut.recommendedAction).toBe('switch-seat');
    expectValidRecoveryIssue(limit);
    expectValidRecoveryIssue(signedOut);
  });

  it('names the brief a hint halted on and can skip it; a review halt names none', () => {
    const task = makeTask({ id: 'T004', suggestedFiles: ['src/alpha.ts'] });
    const hint = buildPlannerCallFailedRecoveryIssue({
      diagnosis: { failure: 'usage-limit', message: 'Codex hit its usage limit.' },
      task,
      phase: 'escalating',
      runner: plannerRunner,
      seatSwap: plannerSeatSwap,
      createdAt,
    });
    const review = buildPlannerCallFailedRecoveryIssue({
      diagnosis: { failure: 'usage-limit', message: 'Codex hit its usage limit.' },
      seat: 'review',
      phase: 'final-review',
      runner: plannerRunner,
      seatSwap: plannerSeatSwap,
      createdAt,
    });

    expect(hint).toMatchObject({
      seat: 'plan',
      taskId: 'T004',
      files: ['src/alpha.ts'],
      affectedTaskIds: ['T004'],
    });
    expect(hint.availableActions).toEqual([
      'retry-same-worker',
      'switch-seat',
      'skip-current-task',
      'end-run',
    ]);
    expect(review.seat).toBe('review');
    expect(review.taskId).toBeUndefined();
    expect(review.availableActions).toEqual(['retry-same-worker', 'switch-seat', 'end-run']);
    expectValidRecoveryIssue(hint);
    expectValidRecoveryIssue(review);
  });
});

describe('the planner-output halts', () => {
  it.each(['plan-questions-exhausted', 'plan-checks-failed'] as const)(
    'a planning session halt (%s) keeps the plan seat and recommends the correction',
    (reason) => {
      const issue = buildPlanSessionHaltRecoveryIssue({
        reason,
        phase: 'planning',
        message: 'The planning session stopped.',
        details: ['uncovered-criterion: Criterion C2 is served by no task.'],
        createdAt,
      });

      expect(issue.reason).toBe(reason);
      expect(issue.seat).toBe('plan');
      expect(issue.availableActions).toEqual(['retry-same-worker', 'revise', 'end-run']);
      expect(issue.recommendedAction).toBe('revise');
      expect(issue.details).toEqual(['uncovered-criterion: Criterion C2 is served by no task.']);
      expectValidRecoveryIssue(issue);
    },
  );
});
