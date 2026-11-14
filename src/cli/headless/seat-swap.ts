import { resolveReviewCadence } from '../../core/config/runtime/resolve.js';
import {
  applyOfferedSeatSwap,
  type SeatSwapChoice,
} from '../../engine/orchestrator/run/seat-swap.js';
import type { prepareExecution } from '../../engine/runners/prepare-execution/prepare.js';
import { emitRecoveryAndFailIfPending } from './outcome.js';
import { loadOwnedState, publishHandoffNotice, recoveryBus } from './recovery-step.js';
import type { HeadlessRun } from './types.js';

/**
 * The automatic intent a halt left is taken before the run that would hit the same seat again:
 * an admitted swap resolves the halt and prepares this session on the new seat, so
 * `runWorkflow`'s re-entry runs on it.
 */
export async function takeAutomaticSeatSwap(
  run: HeadlessRun,
  policy: SeatSwapChoice['policy'],
  signal: AbortSignal,
  prepare: typeof prepareExecution | undefined,
): Promise<void> {
  const before = loadOwnedState(run.ref);
  const auto = before?.pendingRecovery?.switchSeat?.auto;
  if (before === null || auto === undefined || run.onSeatDown === 'halt') return;
  const swapped = await applyOfferedSeatSwap({
    choice: { candidate: auto.candidate, policy },
    ...run.ref,
    bus: recoveryBus(run),
    config: run.prepared.config,
    prepared: run.prepared,
    savedState: before,
    signal,
    ...(prepare !== undefined && { prepare }),
  });
  if (swapped !== undefined) {
    run.prepared = swapped.prepared;
    run.savedState = swapped.state;
  }
  // A swap that did not resolve the halt leaves the same intent pending; there
  // is no picker headlessly, so the halt is reported exactly as one no one
  // answered and the run stops.
  const after = loadOwnedState(run.ref);
  if (after !== null && after.pendingRecovery?.switchSeat?.auto !== undefined) {
    await publishHandoffNotice(run, after);
    emitRecoveryAndFailIfPending({
      state: after,
      sessionId: run.ref.sessionId,
      reviewNone: resolveReviewCadence(run.prepared.config) === 'none',
      writeRecord: run.writeRecord,
    });
  }
}
