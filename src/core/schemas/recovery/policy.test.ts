import { describe, expect, it } from 'vitest';
import { RECOVERY_REASONS } from '../enums.js';
import { allowedActionsForReason } from './policy.js';

describe('allowedActionsForReason', () => {
  it('scope-violation allows retry-same-worker, skip-current-task, pause-run, abort-workflow', () => {
    expect(allowedActionsForReason('scope-violation')).toEqual([
      'retry-same-worker',
      'skip-current-task',
      'pause-run',
      'abort-workflow',
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
      'abort-workflow',
    ]);
  });

  it('implementer-timeout-repeated shares the usage-limit action set', () => {
    expect(allowedActionsForReason('implementer-timeout-repeated')).toEqual(
      allowedActionsForReason('runner-usage-limit'),
    );
  });

  it('snapshot-failed allows a retry, a pause or an abort', () => {
    expect(allowedActionsForReason('snapshot-failed')).toEqual([
      'retry-same-worker',
      'pause-run',
      'abort-workflow',
    ]);
  });

  it('review-failed only pauses or aborts', () => {
    expect(allowedActionsForReason('review-failed')).toEqual(['pause-run', 'abort-workflow']);
  });

  it('returns a non-empty fresh array for every reason', () => {
    for (const reason of RECOVERY_REASONS) {
      const actions = allowedActionsForReason(reason);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions).not.toBe(allowedActionsForReason(reason));
    }
  });
});
