import { describe, expect, it } from 'vitest';
import { RECOVERY_REASONS } from '../enums.js';
import { allowedActionsForReason } from './policy.js';

describe('allowedActionsForReason', () => {
  it('scope-violation allows retry-same-worker, skip-current-task, pause-run, end-run', () => {
    expect(allowedActionsForReason('scope-violation')).toEqual([
      'retry-same-worker',
      'skip-current-task',
      'pause-run',
      'end-run',
    ]);
  });

  it('approval-denied shares the scope-violation action set', () => {
    expect(allowedActionsForReason('approval-denied')).toEqual(
      allowedActionsForReason('scope-violation'),
    );
  });

  it('implementer-recipe-invalid offers a seat switch but no bigger worker', () => {
    expect(allowedActionsForReason('implementer-recipe-invalid')).toEqual([
      'retry-same-worker',
      'switch-seat',
      'pause-run',
      'end-run',
    ]);
  });

  it.each(['runner-timeout-repeated', 'runner-unauthenticated'] as const)(
    '%s shares the blocked-seat action set with runner-usage-limit',
    (reason) => {
      expect(allowedActionsForReason(reason)).toEqual(
        allowedActionsForReason('runner-usage-limit'),
      );
    },
  );

  it('planner-call-failed has no task to skip and no bigger worker to route to', () => {
    expect(allowedActionsForReason('planner-call-failed')).toEqual([
      'retry-same-worker',
      'switch-seat',
      'pause-run',
      'end-run',
    ]);
  });

  it.each(['planner-returned-no-briefs', 'brief-quality-unrepaired'] as const)(
    '%s offers a re-issue, a correction or an end',
    (reason) => {
      expect(allowedActionsForReason(reason)).toEqual(['retry-same-worker', 'revise', 'end-run']);
    },
  );

  it('brief-review-no-progress only revises or ends', () => {
    expect(allowedActionsForReason('brief-review-no-progress')).toEqual(['revise', 'end-run']);
  });

  it('constitution-check-failed only revises the spec or ends', () => {
    expect(allowedActionsForReason('constitution-check-failed')).toEqual([
      'revise-spec',
      'end-run',
    ]);
  });

  it('snapshot-failed allows a retry, a pause or an abort', () => {
    expect(allowedActionsForReason('snapshot-failed')).toEqual([
      'retry-same-worker',
      'pause-run',
      'end-run',
    ]);
  });

  it('review-failed only pauses or ends the run', () => {
    expect(allowedActionsForReason('review-failed')).toEqual(['pause-run', 'end-run']);
  });

  it('returns a non-empty fresh array for every reason', () => {
    for (const reason of RECOVERY_REASONS) {
      const actions = allowedActionsForReason(reason);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions).not.toBe(allowedActionsForReason(reason));
    }
  });
});
