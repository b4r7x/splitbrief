import { SANDBOX_DIR } from '../../../core/paths.js';
import { clearProcessLedger } from '../../../lib/process/registry.js';
import { warnError } from '../../../lib/warn.js';
import { clearBridgedCliState } from '../../runners/sandbox/state/bridge.js';
import { recordCheckoutRunSnapshot } from './snapshots.js';
import type { RunTracker, ScopedRun } from './types.js';

export async function teardownRun(
  run: ScopedRun,
  tracker: RunTracker,
  stopFollowingState: (() => void) | undefined,
): Promise<void> {
  stopFollowingState?.();
  // Ownership-guarded: acquireLiveness's warn-and-continue escape hatches can
  // let a successor run install its ledger before this superseded run's
  // teardown executes — a bare setProcessLedger(null) would silently disable
  // the successor's runner-pid recording (and with it orphan reaping).
  clearProcessLedger(run.processLedger);
  // A host credential bridged into the project sandbox must not outlive the
  // run that admitted it; the next run re-bridges whatever it needs.
  await clearBridgedCliState(run.ref.projectDir).catch((err: unknown) => {
    warnError(`Could not remove the tool sign-in copies from ${SANDBOX_DIR}`, err);
  });
  // A dispose failure (e.g. git refuses to remove the worktree) is reported,
  // never allowed to escape runWorkflow.
  await run.isolation.dispose().catch((err: unknown) => {
    warnError('Could not remove the run workspace', err);
  });
  // Disposal settles the last attempt revert, so this is the checkout as the run left it.
  const restingBus = tracker.bus;
  if (restingBus !== undefined && tracker.state !== undefined) {
    await recordCheckoutRunSnapshot({
      projectDir: run.ref.projectDir,
      sessionId: run.ref.sessionId,
      bus: restingBus,
      state: tracker.state,
    });
  }
  await run.releaseLiveness();
}
