import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import { availableActionsForReason } from './actions.js';
import { compactFacts, createRecoveryIssue, type RecoveryBuilderBase } from './issue.js';

export type UnrunnableCheck = { checkId: string; output: string };

/**
 * A required check whose status is refused, not-runnable or unknown is a policy
 * problem, not a finding: the run cannot judge the candidate, and no fix task can
 * answer it. The halt names every check id and why it cannot run, and offers the
 * reviewer seat the same re-issue, pause and end the other no-verdict review halts do.
 */
export function buildRequiredChecksUnrunnableRecoveryIssue(
  opts: RecoveryBuilderBase & {
    phase: Phase;
    checks: readonly UnrunnableCheck[];
  },
): RecoveryIssue {
  const checkIds = opts.checks.map((check) => check.checkId);
  const entries = opts.checks.map((check) => `${check.checkId}: ${check.output.trim()}`);
  const actions = availableActionsForReason('required-checks-unrunnable', {
    switchSeat: false,
    routeBigger: false,
  });
  return createRecoveryIssue({
    id: opts.id,
    reason: 'required-checks-unrunnable',
    seat: 'review',
    phase: opts.phase,
    files: [],
    affectedTaskIds: [],
    message: `Required checks cannot run: ${entries.join('; ')}`,
    details: [
      ...entries,
      'A refused or not-runnable required check never becomes a fix task. Correct the check policy, validation.render or the registration, then run again.',
    ],
    facts: compactFacts({ requiredCheckIds: checkIds.join(', ') }),
    availableActions: actions,
    recommendedAction: 'retry-same-worker',
    createdAt: opts.createdAt,
  });
}
