import { getRunnerCatalogDisplayName } from '../../../../core/config/accessors/runner-config.js';
import { leftIsolationCause, repositoryChangedCause } from '../../../../core/recovery/causes.js';
import { replacedFilesSavedIn } from '../../../../core/runtime/commands/messages.js';
import type { RecoveryAction } from '../../../../core/schemas/enums.js';
import type { SwitchSeatOffer, RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { chooseRecommended, haltActions } from './actions.js';
import { taskFiles } from './details.js';
import { createRecoveryIssue, compactFacts } from './issue.js';
import { switchSeatOffer } from './switch-offer.js';
import type { RunnerFailureRecoveryOptions } from './types.js';

/**
 * A halt on what the isolation checks found around one implementer call.
 * The checkout gets nothing until Apply, or, in checkout mode, gets the attempt's
 * edits put back, so the brief halts on the evidence
 * instead of retrying into the same place. The evidence rides in the message,
 * the one line the headless sinks print, and the panel states it once: in the
 * details under its shorter header, or, for a checkout halt, as the `changes`
 * fact its header carries. The attempt count is left out, because no retry was
 * spent on it.
 */
function isolationHaltIssue(
  opts: RunnerFailureRecoveryOptions,
  halt: {
    reason: 'implementer-left-isolation' | 'checkout-changed';
    message: string;
    files: string[];
    details: readonly string[];
    changes?: string;
    actions: RecoveryAction[];
  },
  seatSwap: SwitchSeatOffer | undefined,
): RecoveryIssue {
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: halt.reason,
    phase: opts.phase ?? 'implementing',
    task: opts.task,
    files: halt.files,
    affectedTaskIds: [opts.task.id],
    message: halt.message,
    details: [...halt.details],
    selectedImplementerProfile: opts.selectedImplementerProfile,
    ...(seatSwap !== undefined && { switchSeat: seatSwap }),
    facts: compactFacts({ tool: getRunnerCatalogDisplayName(opts.runner), changes: halt.changes }),
    availableActions: halt.actions,
    recommendedAction: chooseRecommended(halt.actions),
    createdAt: opts.createdAt,
  });
}

/** A tool call named a path the implementer may not reach, and the call was stopped. */
export function buildLeftIsolationRecoveryIssue(opts: RunnerFailureRecoveryOptions): RecoveryIssue {
  const evidence = `${getRunnerCatalogDisplayName(opts.runner)} ${opts.toolMessage}`;
  const seatSwap = switchSeatOffer(opts.seatSwap);
  return isolationHaltIssue(
    opts,
    {
      reason: 'implementer-left-isolation',
      message: `${leftIsolationCause(opts.task.id)}${SOFT_SEP}${evidence}`,
      files: taskFiles(opts.task),
      details: [
        evidence,
        opts.inPlace === undefined
          ? "Your checkout gets the run's changes only through Apply."
          : 'The files this attempt changed stay in your checkout.',
      ],
      actions: haltActions('implementer-left-isolation', [
        'retry-same-worker',
        seatSwap === undefined ? undefined : 'switch-seat',
        'skip-current-task',
        'end-run',
      ]),
    },
    seatSwap,
  );
}

/**
 * The repository's git state changed while the call ran. The audit sees what
 * changed, not who changed it — a commit of yours or a branch another session
 * creates lands here as readily as a tool's — so the words name the repository,
 * never the implementer. The halt is about git state, so it lists no brief file.
 */
export function buildCheckoutChangedRecoveryIssue(
  opts: RunnerFailureRecoveryOptions,
): RecoveryIssue {
  return isolationHaltIssue(
    opts,
    {
      reason: 'checkout-changed',
      message: repositoryChangedCause(opts.task.id, opts.toolMessage),
      files: [],
      changes: opts.toolMessage,
      details: [
        `Changed while ${getRunnerCatalogDisplayName(opts.runner)} ran; the audit cannot tell who made the change.`,
        opts.inPlace === undefined
          ? "Your checkout gets the run's changes only through Apply, and nothing in your checkout was reverted."
          : `SPLITBRIEF put back the files this attempt changed in your checkout. ${replacedFilesSavedIn(opts.inPlace.revertedDir)}. The git change stays for you to check.`,
      ],
      actions: haltActions('checkout-changed', [
        'retry-same-worker',
        'skip-current-task',
        'end-run',
      ]),
    },
    undefined,
  );
}
