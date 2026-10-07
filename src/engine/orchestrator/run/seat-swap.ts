import type { Config } from '../../../core/schemas/config.js';
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
  savedState: WorkflowState | undefined;
  signal?: AbortSignal | undefined;
  /** Called once the swap is admitted, with the preparation the seats are now built from. */
  onSeatSwapped?: ((prepared: PreparedExecution) => void) | undefined;
  /** The preparation call; the run loop passes its own, so a swap prepares the way every re-entry does. */
  prepare?: typeof prepareExecution | undefined;
}>;

/**
 * A quota halt offered other tools and the operator took one: prepare this same
 * session on the switched config, write that one seat into `config.yaml`, and
 * only then resolve the pending recovery onto the new tool — so the seat is
 * rebuilt the one way every seat is built, `init-seats.ts` → `runners/factory.ts`,
 * against a preparation that admitted the new tool.
 *
 * A swap the recovery itself refuses changes nothing — the halt is still
 * pending, so the task loop stops on it again. A preparation the operator
 * cancelled, an admission that failed, and a config the operator changed
 * underneath the halt all leave the halt pending with its intent: the write is
 * skipped, so the run keeps the seat it had and stops on it again rather than
 * running on a tool nothing admitted. Only a saved write resolves the halt.
 *
 * The TUI run loop applies the swap before it re-enters `runWorkflow`, and an
 * admitted swap is that re-entry's only preparation: the seat that halted is
 * never admitted again, so a tool that can no longer run cannot block the move
 * away from it. The new preparation goes to `onSeatSwapped`, and every later
 * pass runs on it, not on the seat that hit the limit.
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

  if (result.kind === 'unswitched') {
    // Nothing was written, so the halt stays pending and the run stops on it again
    // on the seat it had. A cancellation is the operator's own, reported by the
    // cancel path; a refused admission and a raced config name their own row.
    if (result.outcome === 'conflict') {
      publishWarning({
        bus: input.bus,
        phase: result.state.phase,
        message: 'config changed meanwhile · the halt stays',
      });
    } else if (result.outcome === 'unadmitted') {
      const reason =
        result.preparation.kind === 'failed'
          ? `preparing it failed: ${toErrorMessage(result.preparation.error)}`
          : 'it could not be admitted';
      publishWarning({
        bus: input.bus,
        phase: result.state.phase,
        message: `The ${result.seat} seat was not switched to '${result.candidate.tool}': ${reason}; the halt stays.`,
      });
    }
    return { config: input.config, prepared: input.prepared, state: result.state };
  }

  const preparation = result.preparation;
  input.onSeatSwapped?.(preparation.execution);
  return {
    config: preparation.execution.config,
    prepared: preparation.execution,
    state: result.state,
  };
}
