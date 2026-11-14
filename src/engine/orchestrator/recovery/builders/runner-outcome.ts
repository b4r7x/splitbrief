import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { RunnerFailureOutcomeState } from '../../../runners/errors.js';
import {
  buildRecipeInvalidRecoveryIssue,
  buildMissingModelRecoveryIssue,
  buildRepeatedTimeoutRecoveryIssue,
  buildRunnerInputTooLargeRecoveryIssue,
  buildRunnerCheckFailedRecoveryIssue,
} from './runner-defect.js';
import { buildLeftIsolationRecoveryIssue, buildCheckoutChangedRecoveryIssue } from './isolation.js';
import type { RunnerFailureRecoveryOptions } from './types.js';

const RUNNER_DEFECT_BUILDERS: Partial<
  Record<RunnerFailureOutcomeState, (opts: RunnerFailureRecoveryOptions) => RecoveryIssue>
> = {
  'implementer-recipe-invalid': buildRecipeInvalidRecoveryIssue,
  'implementer-left-isolation': buildLeftIsolationRecoveryIssue,
  'checkout-changed': buildCheckoutChangedRecoveryIssue,
  'missing-model': buildMissingModelRecoveryIssue,
  'runner-timeout-repeated': buildRepeatedTimeoutRecoveryIssue,
  'input-too-large': buildRunnerInputTooLargeRecoveryIssue,
  'runner-check-failed': buildRunnerCheckFailedRecoveryIssue,
};

/**
 * The one table of outcomes a runner defect raises straight to recovery, keyed
 * by the outcome the runner reported. Every caller that halts on one — the
 * first attempt and every rung of the ladder — reads its builder from here, so
 * a fourth outcome is remembered once instead of in each of them.
 */
export function recoveryBuilderForRunnerOutcome(
  outcome: RunnerFailureOutcomeState,
): ((opts: RunnerFailureRecoveryOptions) => RecoveryIssue) | undefined {
  return RUNNER_DEFECT_BUILDERS[outcome];
}
