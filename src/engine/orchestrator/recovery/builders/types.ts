import type { Config } from '../../../../core/schemas/config.js';
import type { SeatSwitchRecord } from '../../../../core/schemas/workflow/seat.js';
import type { RunnerCallError } from '../../../calls/types.js';
import type { SeatSwapContext } from '../seat/swap-context.js';
import type { RecoveryBuilderBase, TaskRecoveryContext } from './issue.js';

/**
 * What every halt a runner itself caused needs: the seat's runner, the tool's
 * own words, and — when the machine remembered another ready tool — the seat
 * the operator could move to. The shape carries no discriminant: a signed-out
 * runner, an exhausted quota, a refused command line and a brief that timed out
 * twice all halt on the same three inputs.
 */
export interface RunnerFailureRecoveryOptions extends RecoveryBuilderBase, TaskRecoveryContext {
  runner: Config['implementer'];
  toolMessage: string;
  transportError?: RunnerCallError | undefined;
  seatSwap?: SeatSwapContext | undefined;
  /** The switches this run already made, so a seat is moved to its fallback at most once. */
  seatSwitches?: readonly SeatSwitchRecord[] | undefined;
  /**
   * The call ran in the checkout itself (`workflow.isolation: none`): nothing is
   * promoted there. A *Needs you* halt put the attempt's files back with the bytes
   * they replaced saved in `revertedDir`; a *Seat down* halt keeps them.
   */
  inPlace?: { revertedDir: string } | undefined;
}
