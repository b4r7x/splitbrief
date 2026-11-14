import { describe, expect, it } from 'vitest';
import { buildCheckoutChangedRecoveryIssue, buildLeftIsolationRecoveryIssue } from './isolation.js';
import {
  buildMissingModelRecoveryIssue,
  buildRecipeInvalidRecoveryIssue,
  buildRepeatedTimeoutRecoveryIssue,
} from './runner-defect.js';
import { recoveryBuilderForRunnerOutcome } from './runner-outcome.js';

describe('recoveryBuilderForRunnerOutcome', () => {
  it('maps every runner defect to its builder and nothing else', () => {
    expect(recoveryBuilderForRunnerOutcome('implementer-recipe-invalid')).toBe(
      buildRecipeInvalidRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('missing-model')).toBe(buildMissingModelRecoveryIssue);
    expect(recoveryBuilderForRunnerOutcome('implementer-left-isolation')).toBe(
      buildLeftIsolationRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('checkout-changed')).toBe(
      buildCheckoutChangedRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('runner-timeout-repeated')).toBe(
      buildRepeatedTimeoutRecoveryIssue,
    );
    expect(recoveryBuilderForRunnerOutcome('timeout')).toBeUndefined();
    expect(recoveryBuilderForRunnerOutcome('unauthenticated')).toBeUndefined();
  });
});
