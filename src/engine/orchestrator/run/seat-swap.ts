import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import type { SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import type { PreparedExecution } from '../../runners/prepared-execution.js';
import type { PreparationPolicy } from '../../runners/prepare-execution/types.js';
import type { prepareExecution } from '../../runners/prepare-execution/prepare-execution.js';
import { switchSeatAndPrepareResume } from '../recovery/switch-seat-resume.js';
import { publishWarning } from '../events.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

/** The seat swap a quota halt offered, as the operator took it. */
export type SeatSwapChoice = Readonly<{
  candidate: SeatSwapCandidate;
  /** The policy this run was admitted under; the swapped-in tool is admitted under the same one. */
  policy: Extract<PreparationPolicy, { purpose: 'resume' }>;
}>;

export type SeatSwapOutcome = Readonly<{
  config: Config;
  prepared: PreparedExecution;
  state: WorkflowState;
}>;

export type ApplyOfferedSeatSwapInput = Readonly<{
  choice: SeatSwapChoice | undefined;
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  config: Config;
  prepared: PreparedExecution;
  mode?: WorkflowMode | undefined;
  savedState: WorkflowState | undefined;
  signal?: AbortSignal | undefined;
  /** Called once the swap is admitted, with the preparation the seats are now built from. */
  onSeatSwapped?: ((prepared: PreparedExecution) => void) | undefined;
  /** Test-only: inject the preparation call (the production path re-prepares for real). */
  prepare?: typeof prepareExecution | undefined;
}>;

/**
 * A quota halt offered other tools and the operator took one: resolve the
 * pending recovery onto that tool and prepare this same session again on the
 * switched config, so the seat is rebuilt the one way every seat is built —
 * `init-seats.ts` → `runners/factory.ts`, against a preparation that admitted
 * the new tool.
 *
 * A swap the recovery itself refuses changes nothing — the halt is still
 * pending, so the task loop stops on it again. A swap that resolves but cannot
 * be admitted keeps the resolved state (it is already on disk) and the seat the
 * run already had: that seat is the one that hit the limit, so it halts again
 * rather than running on a tool nothing admitted. A re-preparation the operator
 * cancelled is that cancellation and not a refusal, so it is not warned about
 * here; a failed one names its own error.
 *
 * An admitted swap hands its new preparation to `onSeatSwapped`: a caller that runs
 * this workflow again must re-run on that one, not on the seat that hit the limit.
 * The seat record itself is reconciled by `init` once the swapped config is in place.
 */
export async function applyOfferedSeatSwap(
  input: ApplyOfferedSeatSwapInput,
): Promise<SeatSwapOutcome | undefined> {
  const { choice, savedState } = input;
  if (choice === undefined) return undefined;
  if (savedState?.pendingRecovery?.switchSeat === undefined) return undefined;

  const result = await switchSeatAndPrepareResume({
    projectDir: input.projectDir,
    sessionId: input.sessionId,
    state: savedState,
    bus: input.bus,
    config: input.config,
    candidate: choice.candidate,
    policy: choice.policy,
    signal: input.signal ?? new AbortController().signal,
    ...(input.mode !== undefined && { mode: input.mode }),
    ...(input.prepare !== undefined && { prepare: input.prepare }),
  });

  if (result.kind === 'blocked') {
    publishWarning({
      bus: input.bus,
      phase: savedState.phase,
      message: `Could not switch the seat to '${choice.candidate.tool}': ${result.message}`,
    });
    return undefined;
  }

  const preparation = result.preparation;
  if (preparation.kind !== 'prepared') {
    // The resolved recovery is already on disk, so the state travels back even when
    // the swap did not: the run keeps the seat it had and halts on it again.
    const unswapped = { config: input.config, prepared: input.prepared, state: result.state };
    // `aborted` is the operator's own cancellation during re-preparation, which the
    // cancel path reports itself; nothing was refused, so nothing is warned here.
    if (preparation.kind === 'aborted') return unswapped;
    const reason =
      preparation.kind === 'failed'
        ? `preparing it failed: ${toErrorMessage(preparation.error)}`
        : 'it could not be admitted';
    publishWarning({
      bus: input.bus,
      phase: result.state.phase,
      message: `Switched the ${result.seat} seat to '${result.candidate.tool}', but ${reason}; the run continues on its previous seat.`,
    });
    return unswapped;
  }

  input.onSeatSwapped?.(preparation.execution);
  return {
    config: preparation.execution.config,
    prepared: preparation.execution,
    state: result.state,
  };
}
