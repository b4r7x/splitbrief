import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import { publishRecoveryResolved } from '../../publish/recovery.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import { isSafeContinue, blockRecoveryAction, markRecoveryApplying } from './shared.js';
import type { ApplyRecoveryActionOptions, ApplyRecoveryActionResult } from './types.js';

export function applyContinueRecoveryAction(
  opts: ApplyRecoveryActionOptions,
  issue: RecoveryIssue,
): ApplyRecoveryActionResult {
  if (!isSafeContinue(issue)) {
    return blockRecoveryAction({
      ...opts,
      issue,
      code: 'unsafe-continue',
      message: `Recovery issue ${issue.reason} cannot be continued safely.`,
      publishSelected: true,
    });
  }

  let state = markRecoveryApplying(opts, issue);
  state = transitionAndSave(
    opts,
    state,
    {
      type: 'RESOLVE_PENDING_RECOVERY',
    },
    { expectedRevision: state.stateRevision ?? 0 },
  );
  publishRecoveryResolved({
    bus: opts.bus,
    phase: state.phase,
    issue,
    action: opts.action,
    outcome: 'continued',
  });

  return {
    ok: true,
    action: opts.action,
    issue,
    state,
    status: 'continued',
    correctionRecorded: false,
  };
}
