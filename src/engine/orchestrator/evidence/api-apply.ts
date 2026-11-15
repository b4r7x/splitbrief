import { findOrSeed, upsertEvidenceTask } from '../../../core/evidence/ledger-state.js';
import { mutateEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { EvidenceApiApply, EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { uniquePush } from '../../../utils/collections.js';
import type { BundleApplyResult } from '../../implementers/file-bundle/contract.js';
import type { WorkflowContext } from '../types.js';
import { getOrCreateLedger, warnEvidenceNotSaved } from './ledger.js';
import { provenCreatedPaths, withTargetWrites } from './target-writes.js';

/**
 * §6: the bundle's receipt is written before the attempt's own outcome is
 * handled, so a brief that stops mid-application still leaves the applied prefix
 * on the record. A write that fails is a warning rather than a halt: the next
 * attempt then finds no proof of ownership and parks, which is the safe answer.
 */
export function persistApiApplyEvidence(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  task: Task;
  result: BundleApplyResult;
  workspacePath: string;
}): void {
  const { wctx, state, task, result } = opts;
  try {
    mutateEvidenceLedger(wctx, (existing) =>
      recordApiApplyEvidence({
        ledger: existing ?? getOrCreateLedger({ ref: wctx, state }),
        task,
        result,
        workspacePath: opts.workspacePath,
      }),
    );
  } catch (err) {
    warnEvidenceNotSaved(wctx, state.phase, err);
  }
}

/**
 * The §6 receipt for one bundle application: what the response proposed, what
 * landed, and where it stopped. Digests travel, contents do not.
 */
function apiApplyReceipt(result: BundleApplyResult): EvidenceApiApply {
  return {
    callId: result.callId,
    grammar: 'file-bundle-v1',
    status: result.status,
    candidatePaths: [...result.candidatePaths],
    applied: result.applied.map((file) => ({
      path: file.path,
      action: file.action,
      beforeSha256: file.beforeSha256,
      afterSha256: file.afterSha256,
      ...(file.afterMode === undefined ? {} : { afterMode: file.afterMode }),
    })),
    noops: [...result.noops],
    untouched: [...result.untouched],
    ...(result.status === 'partial' || result.status === 'failed'
      ? { failedPath: result.failedPath }
      : {}),
    ...(result.status === 'applied' ? {} : { code: result.code }),
  };
}

/** A restore removes creation proof only for paths the snapshot puts back to absence. */
export function recordApiRevertEvidence(input: {
  ledger: EvidenceLedger;
  workspacePath: string;
  removedPaths: readonly string[];
}): EvidenceLedger {
  const removed = new Set(input.removedPaths);
  return {
    ...input.ledger,
    tasks: input.ledger.tasks.map((entry) => {
      if (entry.apiApply?.workspacePath !== input.workspacePath) return entry;
      return {
        ...entry,
        apiCreatedPaths: provenCreatedPaths(entry, input.workspacePath).filter(
          (path) => !removed.has(path),
        ),
        apiApply: {
          ...entry.apiApply,
          revertedPaths: [...new Set([...(entry.apiApply.revertedPaths ?? []), ...removed])],
        },
      };
    }),
  };
}

export type RecordApiApplyEvidenceInput = {
  ledger: EvidenceLedger;
  task: Task;
  result: BundleApplyResult;
  workspacePath?: string | undefined;
};

/**
 * The durable record of what one bundle response did on disk, written before
 * the attempt's own outcome is decided. Together with promotion receipts, it
 * proves which targets this task created. Without creation proof, a retry
 * within the same dispatch parks a create brief whose anchor now exists.
 */
export function recordApiApplyEvidence(input: RecordApiApplyEvidenceInput): EvidenceLedger {
  const next = findOrSeed(input.ledger, input.task);
  const created = provenCreatedPaths(next, input.workspacePath);
  next.apiApply = {
    ...apiApplyReceipt(input.result),
    ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
  };
  for (const file of next.apiApply.applied) {
    if (input.workspacePath === undefined) uniquePush(next.changedFiles, file.path);
    if (file.action === 'create' && file.beforeSha256 === null) uniquePush(created, file.path);
  }
  if (created.length > 0) next.apiCreatedPaths = created;
  else delete next.apiCreatedPaths;
  // An application that stopped mid-bundle leaves the brief failed until
  // recovery moves it: nothing after the failing path was attempted, and the
  // prefix remains in the receipt even when checkout recovery puts it back.
  if (input.result.status === 'partial') next.status = 'failed';
  const updated = upsertEvidenceTask(input.ledger, next);
  if (input.workspacePath !== undefined) return updated;
  return withTargetWrites({
    ledger: updated,
    task: input.task,
    files: input.result.applied.map((file) => ({
      path: file.path,
      sha256: file.afterSha256,
      mode: file.afterMode ?? null,
    })),
    unknownPaths:
      input.result.status === 'partial' || input.result.status === 'failed'
        ? [input.result.failedPath]
        : [],
  });
}
