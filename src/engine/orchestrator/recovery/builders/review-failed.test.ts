import { describe, expect, it } from 'vitest';
import { formatRecoveryHeadline } from '../../../../core/recovery/headline.js';
import { taskId } from '../../../../core/schemas/task.js';
import {
  createdAt,
  expectValidRecoveryIssue,
  LONG_PLANNER_REASON,
} from '#testing/helpers/recovery-issue.js';
import { buildReviewFailedRecoveryIssue } from './review-failed.js';

describe('buildReviewFailedRecoveryIssue', () => {
  it('counts the blocking findings and offers a correction or the end, recommending the correction', () => {
    const issue = buildReviewFailedRecoveryIssue({
      createdAt,
      blocking: 3,
      details: ['Planner: the brief names no test', 'Reviewer: F1: missing test for the new route'],
    });

    expect(issue.reason).toBe('review-failed');
    expect(issue.details).toEqual([
      'Planner: the brief names no test',
      'Reviewer: F1: missing test for the new route',
    ]);
    expect(issue.phase).toBe('final-review');
    expect(issue.message).toBe('Final review failed with 3 blocking findings');
    expect(issue.availableActions).toEqual(['revise', 'end-run']);
    expect(issue.recommendedAction).toBe('revise');
    expectValidRecoveryIssue(issue);
  });

  it('offers Decide for me on a review question nobody answered, and keeps the question', () => {
    const issue = buildReviewFailedRecoveryIssue({
      createdAt,
      blocking: 1,
      question: 'Is V1 the right gate command?',
      details: ['V1.1: Reviewer check V1 failed'],
    });

    expect(issue.availableActions).toEqual(['revise', 'decide-for-me', 'end-run']);
    expect(issue.recommendedAction).toBe('revise');
    expect(issue.facts).toMatchObject({ question: 'Is V1 the right gate command?' });
    expect(issue.details).toEqual([
      'The review asked a question this run has no way to answer.',
      'Question: Is V1 the right gate command?',
      'V1.1: Reviewer check V1 failed',
    ]);
    expectValidRecoveryIssue(issue);
  });

  it('keeps the whole planner reason of a review stuck halt', () => {
    const issue = buildReviewFailedRecoveryIssue({
      createdAt,
      phase: 'implementing',
      blocking: 1,
      noProgress: ['F1'],
      fixCycle: 2,
      cannot: LONG_PLANNER_REASON,
      scope: 'task',
      afterTaskId: taskId('T004'),
    });

    expect(issue.details).toContain(`Planner said: ${LONG_PLANNER_REASON}`);
    expectValidRecoveryIssue(issue);
  });

  it('names the blockers a final review round moved nothing on', () => {
    const noFix = buildReviewFailedRecoveryIssue({
      createdAt,
      blocking: 1,
      noProgress: ['P1'],
      scope: 'final',
    });
    const sameBlockers = buildReviewFailedRecoveryIssue({
      createdAt,
      blocking: 5,
      noProgress: ['V1.1', 'V1.2', 'P1', 'F1', 'F2'],
      fixCycle: 3,
      scope: 'final',
    });

    expect(noFix.message).toBe('Final review found no fix for P1');
    expect(formatRecoveryHeadline(noFix)).toBe('Final review found no fix for P1');
    expect(noFix.facts).toMatchObject({ blocking: 1, noProgress: 'P1' });
    expect(sameBlockers.message).toBe(
      'Final review made no progress on V1.1, V1.2, P1 +2 more after fix cycle 3',
    );
    expect(formatRecoveryHeadline(sameBlockers)).toBe(sameBlockers.message);
    expect(sameBlockers.facts).toMatchObject({ noProgress: 'V1.1,V1.2,P1,F1,F2', fixCycle: 3 });
    for (const issue of [noFix, sameBlockers]) expectValidRecoveryIssue(issue);
  });

  it('reads an older halt stopped at the fix-cycle cap by its blocking count', () => {
    const issue = buildReviewFailedRecoveryIssue({ createdAt, blocking: 1, scope: 'final' });
    const older = { ...issue, facts: { ...issue.facts, fixCycles: 2 } };

    expect(formatRecoveryHeadline(older)).toBe('Final review failed with 1 blocking finding');
  });

  it('names the task review of the brief it judged, with no progress and with no fix work', () => {
    const task = { scope: 'task', afterTaskId: taskId('T004') } as const;
    const stuck = buildReviewFailedRecoveryIssue({
      createdAt,
      phase: 'implementing',
      blocking: 1,
      noProgress: ['F1'],
      fixCycle: 2,
      ...task,
    });
    const blocking = buildReviewFailedRecoveryIssue({
      createdAt,
      phase: 'implementing',
      blocking: 1,
      ...task,
    });
    const unverified = buildReviewFailedRecoveryIssue({
      createdAt,
      phase: 'implementing',
      blocking: 0,
      unverified: 1,
      ...task,
    });

    expect(stuck.message).toBe('Review T004 made no progress on F1 after fix cycle 2');
    expect(formatRecoveryHeadline(stuck)).toBe(
      'Review T004 made no progress on F1 after fix cycle 2',
    );
    expect(blocking.message).toBe('Review T004 failed with 1 blocking finding');
    expect(formatRecoveryHeadline(blocking)).toBe('Review T004 failed with 1 blocking finding');
    expect(unverified.message).toBe('Review T004 failed with 1 unverified criterion');
    expect(formatRecoveryHeadline(unverified)).toBe(
      'Review T004 failed with 1 unverified criterion',
    );
    for (const issue of [stuck, blocking, unverified]) expectValidRecoveryIssue(issue);
  });

  it('points a review whose only failures are render criteria its seat could not see at the review seat', () => {
    const issue = buildReviewFailedRecoveryIssue({
      createdAt,
      blocking: 0,
      unverified: 2,
      reviewSeatNoImages: true,
      cannot: 'The render criteria need a reviewer that sees images',
      details: ['Unverified criteria: C1, C2'],
      acceptAsIs: true,
      scope: 'final',
    });

    expect(issue.message).toBe('Final review needs a REVIEW seat that reads images');
    expect(formatRecoveryHeadline(issue)).toBe(issue.message);
    expect(issue.seat).toBe('review');
    expect(issue.availableActions).not.toContain('revise');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'accept-as-is', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(issue.details).toEqual([
      'Planner said: The render criteria need a reviewer that sees images',
      'Unverified criteria: C1, C2',
      'Change the review seat to a tool that reads images with /crew review, then choose Try again.',
    ]);
    expectValidRecoveryIssue(issue);
  });

  it('keeps Review again on a review with unverified criteria its seat could see', () => {
    const issue = buildReviewFailedRecoveryIssue({
      createdAt,
      blocking: 0,
      unverified: 1,
      acceptAsIs: true,
      scope: 'final',
    });

    expect(issue.message).toBe('Final review failed with 1 unverified criterion');
    expect(issue.seat).toBe('build');
    expect(issue.recommendedAction).toBe('revise');
    expect(issue.availableActions).not.toContain('retry-same-worker');
  });

  it('names the task review that reached no verdict, and the final review unchanged', () => {
    const failure = {
      kind: 'call-failed',
      code: 'exit-1',
      message: 'Review T004 failed.',
    } as const;
    const task = buildReviewFailedRecoveryIssue({
      createdAt,
      phase: 'implementing',
      failure,
      scope: 'task',
      afterTaskId: taskId('T004'),
    });
    const final = buildReviewFailedRecoveryIssue({ createdAt, failure, scope: 'final' });

    expect(formatRecoveryHeadline(task)).toBe('Review T004 reached no verdict');
    expect(formatRecoveryHeadline(final)).toBe('Final review reached no verdict');
    for (const issue of [task, final]) expectValidRecoveryIssue(issue);
  });

  it('offers accept as is on a reviewed workspace', () => {
    const issue = buildReviewFailedRecoveryIssue({ createdAt, blocking: 1, acceptAsIs: true });

    expect(issue.availableActions).toEqual(['revise', 'accept-as-is', 'end-run']);
    expect(issue.recommendedAction).toBe('revise');
    expectValidRecoveryIssue(issue);
  });

  it.each(['exit-1', 'timeout', 'transport-error'])(
    'offers a retry without a seat remedy after %s',
    (code) => {
      const issue = buildReviewFailedRecoveryIssue({
        createdAt,
        failure: { kind: 'call-failed', code, message: 'Review call failed.' },
      });

      expect(issue.seat).toBe('review');
      expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
      expect(issue.recommendedAction).toBe('retry-same-worker');
      expect(issue.details).toEqual([]);
      expectValidRecoveryIssue(issue);
    },
  );

  it('offers more context only when the review was not given enough context', () => {
    const issue = buildReviewFailedRecoveryIssue({
      createdAt,
      failure: {
        kind: 'insufficient-context',
        diagnostic: {
          code: 'insufficient-context',
          seat: 'review',
          cause: 'input-budget',
          missingSections: [],
        },
      },
    });

    expect(issue.details).toEqual([
      'Pick a review seat with a larger context in /crew review, then choose Try again.',
    ]);
    expectValidRecoveryIssue(issue);
  });
});
