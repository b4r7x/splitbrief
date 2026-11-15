import type { ImplementerOptions, ImplementerPublisher } from '../types.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { getRunnerCatalogDisplayName } from '../../../core/config/accessors/runner-config.js';
import {
  checkoutChanges,
  formatCheckoutChanges,
  snapshotCheckout,
  snapshotWorkspaceGit,
  workspaceGitChanges,
  type CheckoutSnapshot,
  type WorkspaceGitSnapshot,
} from '../isolation/checkout-audit.js';

/** The checkout and the call's own workspace git state, read as one pair. */
export type CheckoutRead = Readonly<{
  checkout: CheckoutSnapshot;
  workspace: WorkspaceGitSnapshot | null;
}>;

const lastInPlaceByRun = new Map<string, { before: CheckoutRead; after: CheckoutRead }>();

/** The call edits the checkout itself: `workflow.isolation: none` hands every writer the project. */
export function worksInPlace(opts: ImplementerOptions): boolean {
  return opts.fileIgnoreProjectDir !== undefined && opts.fileIgnoreProjectDir === opts.projectDir;
}

/**
 * The checkout and the call's own workspace as the isolation audit reads
 * them, or nothing when either read failed: an audit that cannot see the
 * checkout says so and lets the call stand, rather than inventing an escape.
 */
export async function readCheckout(
  publisher: ImplementerPublisher | undefined,
  opts: ImplementerOptions,
  checkoutDir: string,
  workspaceDir: string,
): Promise<CheckoutRead | undefined> {
  try {
    const [checkout, workspace] = await Promise.all([
      snapshotCheckout(checkoutDir),
      snapshotWorkspaceGit(workspaceDir, checkoutDir),
    ]);
    return { checkout, workspace };
  } catch (err) {
    if (opts.phase) {
      publisher?.publishWarning({
        phase: opts.phase,
        taskId: opts.task.id,
        message: `The isolation audit could not read your checkout for task ${opts.task.id}: ${toErrorMessage(err)}`,
        safety: { category: 'implementer', code: 'isolation_audit_failed' },
      });
    }
    return undefined;
  }
}

/**
 * The git state that changed in the checkout or the call's own workspace
 * across one implementer call — a change that went around the isolation
 * directory instead of through promotion. The window is the call alone, so
 * edits between calls never count. A changed file is only reported: an editor
 * save changes files too, and the audit cannot tell who made it. In the
 * checkout itself the call's own writes are the files that change, so none
 * is reported. A stopped call only reports its state change: the run is
 * already halting.
 */
export async function checkoutEscape(
  publisher: ImplementerPublisher | undefined,
  opts: ImplementerOptions,
  checkoutDir: string | undefined,
  before: CheckoutRead | undefined,
): Promise<string[]> {
  if (checkoutDir === undefined || before === undefined) return [];
  const after = await readCheckout(publisher, opts, checkoutDir, opts.projectDir);
  if (after === undefined) return [];
  const { files, state: checkoutState } = checkoutChanges({
    before: before.checkout,
    after: after.checkout,
  });
  const state = [
    ...checkoutState,
    ...workspaceGitChanges({ before: before.workspace, after: after.workspace }),
  ];
  if (files.length > 0 && !worksInPlace(opts) && opts.phase) {
    publisher?.publishWarning({
      phase: opts.phase,
      taskId: opts.task.id,
      message: `Task ${opts.task.id}: your checkout changed while ${getRunnerCatalogDisplayName(opts.config.implementer)} ran — ${formatCheckoutChanges(files)}; nothing there was reverted`,
      safety: { category: 'implementer', code: 'checkout_changed_during_call' },
    });
  }
  if (state.length === 0 || !opts.signal?.aborted) return state;
  if (opts.phase) {
    publisher?.publishWarning({
      phase: opts.phase,
      taskId: opts.task.id,
      message: `Task ${opts.task.id} was stopped; its implementer ran while your checkout changed: ${formatCheckoutChanges(state)}`,
      safety: { category: 'implementer', code: 'implementer_left_isolation' },
    });
  }
  return [];
}

/**
 * An in-place call warns about what changed in the checkout since the last
 * one ended — an edit or a commit of yours. It never halts: the next checks
 * read the checkout as it is.
 */
export function warnChangedBetweenCalls(
  publisher: ImplementerPublisher | undefined,
  opts: ImplementerOptions,
  now: CheckoutRead,
  runKey: string,
): void {
  const last = lastInPlaceByRun.get(runKey);
  if (last === undefined || !opts.phase) return;
  const { files, state } = checkoutChanges({ before: last.after.checkout, after: now.checkout });
  const changes = [
    ...files.filter((file) => now.checkout.files[file] !== last.before.checkout.files[file]),
    ...state,
    ...workspaceGitChanges({ before: last.after.workspace, after: now.workspace }),
  ];
  if (changes.length === 0) return;
  publisher?.publishWarning({
    phase: opts.phase,
    taskId: opts.task.id,
    message: `Task ${opts.task.id}: your checkout changed since the last call — ${formatCheckoutChanges(changes)}; the next checks read it as it is`,
    safety: { category: 'implementer', code: 'checkout_changed_between_calls' },
  });
}

/** The two reads of an in-place call, which the next call of the run compares against. */
export function recordInPlaceCall(
  runKey: string,
  before: CheckoutRead | undefined,
  after: CheckoutRead | undefined,
): void {
  // Without both reads this call's own writes cannot be told from yours, so the next call starts fresh.
  if (before === undefined || after === undefined) lastInPlaceByRun.delete(runKey);
  else lastInPlaceByRun.set(runKey, { before, after });
}
