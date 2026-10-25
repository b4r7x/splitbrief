import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import { haltActions } from './actions.js';
import { compactFacts, createRecoveryIssue, type RecoveryBuilderBase } from './issue.js';

export type UnrunnableCheck = { checkId: string; output: string; missingProgram?: true };

/**
 * A required check whose status is refused, not-runnable or unknown is a policy
 * problem, not a finding: the run cannot judge the candidate, and no fix task can
 * answer it. The halt names every check id and why it cannot run, tells the user to
 * install a missing program or correct the check, and offers the reviewer seat the
 * same re-issue and end the other no-verdict review halts do.
 */
export function buildRequiredChecksUnrunnableRecoveryIssue(
  opts: RecoveryBuilderBase & {
    phase: Phase;
    checks: readonly UnrunnableCheck[];
  },
): RecoveryIssue {
  const checkIds = opts.checks.map((check) => check.checkId);
  const entries = opts.checks.map((check) => `${check.checkId}: ${check.output.trim()}`);
  const missingProgram = opts.checks.some((check) => check.missingProgram === true);
  const otherCause = opts.checks.some((check) => check.missingProgram !== true);
  const actions = haltActions('required-checks-unrunnable', ['retry-same-worker', 'end-run']);
  return createRecoveryIssue({
    id: opts.id,
    reason: 'required-checks-unrunnable',
    seat: 'review',
    phase: opts.phase,
    files: [],
    affectedTaskIds: [],
    message: `Required checks cannot run: ${entries.join('; ')}`,
    details: [
      ...(missingProgram ? ['Install what is missing, then run the checks again.'] : []),
      ...(otherCause ? ['Fix the cause below, then run the checks again.'] : []),
      ...entries,
    ],
    facts: compactFacts({ requiredCheckIds: checkIds.join(', ') }),
    availableActions: actions,
    recommendedAction: 'retry-same-worker',
    createdAt: opts.createdAt,
  });
}
