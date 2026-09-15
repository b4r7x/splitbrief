import { describe, expect, it } from 'vitest';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import type { SeatSwapContext } from './task.js';
import {
  buildBriefQualityUnrepairedRecoveryIssue,
  buildBriefReviewNoProgressRecoveryIssue,
  buildConstitutionCheckFailedRecoveryIssue,
  buildPlannerCallFailedRecoveryIssue,
  buildPlannerNoBriefsRecoveryIssue,
} from './planner.js';

const createdAt = '2026-04-28T12:00:00.000Z';

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
  it('offers a re-issue, a pause and an end, and no task actions', () => {
    const issue = buildPlannerCallFailedRecoveryIssue({
      failure: 'call-failed',
      phase: 'planning',
      message: 'Planning failed.',
      createdAt,
    });

    expect(issue.reason).toBe('planner-call-failed');
    expect(issue.seat).toBe('plan');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'pause-run', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.taskId).toBeUndefined();
    expectValidRecoveryIssue(issue);
  });

  it('adds the seat swap only when another ready tool was detected', () => {
    const issue = buildPlannerCallFailedRecoveryIssue({
      failure: 'call-failed',
      phase: 'planning',
      message: 'Planning failed.',
      seatSwap: plannerSeatSwap,
      createdAt,
    });

    expect(issue.switchSeat).toEqual({
      seat: 'plan',
      candidates: [{ tool: 'claude-code' }],
    });
    expect(issue.availableActions).toContain('switch-seat');
    expectValidRecoveryIssue(issue);
  });

  it('recommends the seat swap for a quota halt and the re-issue for a sign-out', () => {
    const limit = buildPlannerCallFailedRecoveryIssue({
      failure: 'usage-limit',
      phase: 'planning',
      message: 'Codex hit its usage limit.',
      resetAt: '2026-08-08T15:27:00.000Z',
      seatSwap: plannerSeatSwap,
      tool: 'Codex',
      createdAt,
    });
    const signedOut = buildPlannerCallFailedRecoveryIssue({
      failure: 'unauthenticated',
      phase: 'planning',
      message: 'Codex is signed out.',
      seatSwap: plannerSeatSwap,
      createdAt,
    });

    expect(limit.reason).toBe('runner-usage-limit');
    expect(limit.resetAt).toBe('2026-08-08T15:27:00.000Z');
    expect(limit.facts?.tool).toBe('Codex');
    expect(limit.recommendedAction).toBe('switch-seat');
    expect(signedOut.reason).toBe('runner-unauthenticated');
    expect(signedOut.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(limit);
    expectValidRecoveryIssue(signedOut);
  });
});

describe('the planner-output halts', () => {
  it('a brief-less planner answer can be re-issued or corrected', () => {
    const issue = buildPlannerNoBriefsRecoveryIssue({
      phase: 'planning',
      message: 'The planner produced text but no parsable Task Brief.',
      createdAt,
    });

    expect(issue.reason).toBe('planner-returned-no-briefs');
    expect(issue.seat).toBe('plan');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'revise', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });

  it('unrepaired brief quality recommends the correction', () => {
    const issue = buildBriefQualityUnrepairedRecoveryIssue({
      phase: 'reviewing-plan',
      message: 'Task Brief quality gate failed: missing_scope in T001',
      createdAt,
    });

    expect(issue.reason).toBe('brief-quality-unrepaired');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'revise', 'end-run']);
    expect(issue.recommendedAction).toBe('revise');
    expectValidRecoveryIssue(issue);
  });

  it('a stalled brief review only revises or ends, and names no seat', () => {
    const issue = buildBriefReviewNoProgressRecoveryIssue({
      phase: 'reviewing-briefs',
      message: 'Task Brief review made no progress after 20 consecutive attempts.',
      createdAt,
    });

    expect(issue.reason).toBe('brief-review-no-progress');
    expect(issue.seat).toBeUndefined();
    expect(issue.availableActions).toEqual(['revise', 'end-run']);
    expect(issue.recommendedAction).toBe('revise');
    expectValidRecoveryIssue(issue);
  });

  it('a hard constitution violation sends the spec back or ends the run', () => {
    const issue = buildConstitutionCheckFailedRecoveryIssue({
      phase: 'constitution-check',
      message: 'Constitution check failed: no runtime classes',
      details: ['Principle: P1'],
      createdAt,
    });

    expect(issue.reason).toBe('constitution-check-failed');
    expect(issue.seat).toBe('plan');
    expect(issue.availableActions).toEqual(['revise-spec', 'end-run']);
    expect(issue.recommendedAction).toBe('revise-spec');
    expect(issue.details).toEqual(['Principle: P1']);
    expectValidRecoveryIssue(issue);
  });
});
