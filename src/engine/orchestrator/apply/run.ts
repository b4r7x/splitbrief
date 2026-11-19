import { awaitsApply } from '../../../core/sessions/run/status.js';
import { error } from '../../../utils/error.js';
import { acceptedSentence } from '../../../core/review/accepted.js';
import { withCheckoutWriteLock } from '../../checkout-write.js';
import { checkoutWriterRevision } from '../../checkout-writers.js';
import { publishWarning } from '../publish/notice.js';
import { heldLiveness } from '../run/liveness.js';
import { trackActiveApply } from '../session-lifecycle/shutdown.js';
import { readApplyBackup, removeApplyWriteTemporaries } from './backup.js';
import {
  answerApplyRecovery,
  mergeCandidate,
  recheckChangedMerge,
  settleConflicts,
  settleChangedSide,
  writeMerged,
} from './flow.js';
import { bindApplyHandOffs } from './hand-off.js';
import { candidateOf, captureApplyStates } from './states.js';
import { haltCutApply } from './halt.js';
import type { ApplyInput, ApplyResult, ApplyRun, ApplyState } from './types.js';

/**
 * Every Apply, live or at rest, is this process's active Apply until it settles. An Apply that
 * sends the run back to review hands it on; any other end also ends the run, so it stays active
 * until the run releases its liveness, and a queued departure or a shutdown never cuts the run's
 * last writes.
 */
export function runApply(input: ApplyInput): Promise<ApplyResult> {
  const asking = askOverrideConfirmation(input);
  if (asking !== undefined) return Promise.resolve(asking);
  const applying = announcedApply(input);
  void trackActiveApply(
    applying.then(
      (result) => (result.outcome === 'review' ? undefined : heldLiveness(input.wctx)),
      () => heldLiveness(input.wctx),
    ),
  );
  return applying;
}

/** The log names when an Apply starts and ends, so a window that shows the run counts its clock. */
async function announcedApply(input: ApplyInput): Promise<ApplyResult> {
  input.wctx.bus.publish({ type: 'apply_started', ts: Date.now() });
  try {
    return await applyRun(input);
  } finally {
    input.wctx.bus.publish({ type: 'apply_finished', ts: Date.now() });
  }
}

/**
 * A run accepted as is asks for its one confirmation before Apply reads or writes the checkout,
 * so the ask never shows as an Apply in progress. A conflict or a changed checkout is then found
 * after the confirmation. A halted, retried or cut Apply goes on to its own path.
 */
function askOverrideConfirmation(input: ApplyInput): ApplyResult | undefined {
  const { wctx, state } = input;
  const accepted = state.acceptedAsIs;
  if (
    accepted === undefined ||
    !awaitsApply(state) ||
    input.overrideConfirmed === true ||
    state.pendingRecovery !== undefined ||
    state.applying !== undefined
  ) {
    return undefined;
  }
  const reason =
    (accepted.redChecks ?? []).length > 0 ? 'The red checks still fail' : 'No review checked them';
  publishWarning({
    bus: wctx.bus,
    phase: state.phase,
    message: `${acceptedSentence(accepted)} ${reason}; Apply needs one confirmation (/run accept confirm).`,
    safety: { category: 'recovery', code: 'apply_override_unconfirmed' },
  });
  return { outcome: 'needs-confirmation', state };
}

async function applyRun(input: ApplyInput): Promise<ApplyResult> {
  const { wctx, reviewNone, setTrackedState } = input;
  const shared: ApplyState = { state: input.state };
  const recovery = input.state.pendingRecovery;
  if (recovery !== undefined) {
    const answered = await answerApplyRecovery(input, shared, recovery);
    if (answered !== undefined) return answered;
  }
  const { workspace } = shared.state;
  if (!awaitsApply(shared.state) || workspace === undefined || workspace.kind === 'checkout') {
    throw error('apply-not-ready', 'Apply requires a reviewed worktree or staged-copy workspace.');
  }
  if (shared.state.applying !== undefined && recovery === undefined) {
    return {
      outcome: 'halted',
      state: await haltCutApply(
        wctx,
        shared.state,
        shared.state.applying.backupId,
        setTrackedState,
      ),
    };
  }
  // A re-run first removes the temporaries the cut write left beside its files, so the capture
  // never reads them as checkout files.
  if (shared.state.applying !== undefined) {
    const backup = await readApplyBackup(
      wctx.projectDir,
      wctx.sessionId,
      shared.state.applying.backupId,
    );
    await withCheckoutWriteLock(wctx.projectDir, () =>
      removeApplyWriteTemporaries(wctx.projectDir, backup),
    );
  }
  while (true) {
    const checkoutRevision = checkoutWriterRevision(wctx.projectDir);
    const states = await captureApplyStates({
      projectDir: wctx.projectDir,
      sessionId: wctx.sessionId,
      workspace,
    });
    shared.state = bindApplyHandOffs(wctx, shared.state, candidateOf(states));
    setTrackedState?.(shared.state);
    const run: ApplyRun = {
      wctx,
      reviewNone,
      setTrackedState,
      workspace,
      states,
      checkoutRevision,
    };
    try {
      const merged = await mergeCandidate(run, shared);
      if (merged.conflicts.length > 0) return await settleConflicts(run, shared, merged.conflicts);
      const rechecked = await recheckChangedMerge(run, shared);
      if (rechecked !== undefined) return rechecked;
      const written = await writeMerged(run, shared, merged.promote);
      if (written !== undefined) return written;
    } catch (cause) {
      const settled = settleChangedSide(run, shared, cause);
      if (settled !== undefined) return settled;
    }
  }
}
