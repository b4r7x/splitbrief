import { existsSync } from 'node:fs';
import { isTaskSettled, type Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { WorkflowContext } from '../types.js';
import { publishError } from '../publish/notice.js';
import { raisePendingRecovery } from '../state-ops/halts.js';
import { createRecoveryIssue } from '../recovery/builders/issue.js';
import { nowIso } from '../../../utils/format/time.js';
import { mutateEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { isOwnRunWorkspace } from '../isolation/worktree/remove.js';
import {
  recordLocalTaskEvidence,
  recordRemainderEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
  recordStoppedTaskEvidence,
  unbookedFiles,
} from './task.js';
import type { BundleApplyResult } from '../../implementers/file-bundle/contract.js';
import type { TaskCompletionMethod, TaskStatus } from '../../../core/schemas/enums.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { AttemptWorkspace } from '../isolation/types.js';
import { revertedDir, sessionDir } from '../../../core/paths.js';
import { replacedFilesSavedIn } from '../../../core/runtime/commands/messages.js';
import { checkSessionLockStatus } from '../../../core/sessions/lock/status.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import { briefInFlight } from '../../../core/state/selectors.js';
import { changedSinceAtRest } from '../../snapshots/run/rest-changes.js';
import { lineageIdOf } from '../../../core/state/task-insert.js';
import { loadOrCreateLedger, warnEvidenceNotSaved } from './ledger.js';

export async function persistTaskEvidence(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  task: Task;
  recordKind: 'local' | 'retry';
  details: {
    status: TaskStatus;
    method?: TaskCompletionMethod | undefined;
    retries?: number | undefined;
    durationMs?: number | undefined;
    initialChangedFiles?: string[] | undefined;
    escalated?: boolean | undefined;
    changedFiles?: string[] | undefined;
  };
}): Promise<void> {
  const { wctx, state, task, recordKind, details } = opts;
  try {
    mutateEvidenceLedger(wctx, (existing) => {
      const ledger = existing ?? loadOrCreateLedger({ ref: wctx, state });
      if (recordKind === 'local') {
        return recordLocalTaskEvidence({
          ledger,
          task,
          status: details.status,
          method: details.method,
          retries: details.retries,
          durationMs: details.durationMs,
          changedFiles: details.changedFiles,
        });
      }
      return recordRetryOrEscalationEvidence({
        ledger,
        task,
        status: details.status,
        method: details.method,
        retries: details.retries,
        durationMs: details.durationMs,
        escalated: details.escalated ?? false,
        changedFiles: [...(details.initialChangedFiles ?? []), ...(details.changedFiles ?? [])],
      });
    });
  } catch (err) {
    warnEvidenceNotSaved(wctx, state.phase, err);
  }
}

/**
 * A skip takes back the brief's files from its task-start snapshot, so the skipped brief answers
 * only for the files still changed since then. A skip that closes the lineage also took back the
 * attempts a rewrite or a split replaced, so the brief answers only for `lineageFiles`, the
 * lineage's unbooked files: a file its task start held from a replaced attempt reads as changed,
 * though the lineage left it as it was.
 */
export async function persistSkippedBriefFiles(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus' | 'workspaceDir'>;
  state: WorkflowState;
  task: Task;
  reason: string;
  taskStartSnapshot: ChangedFilesSnapshot | undefined;
  lineageFiles: readonly string[] | undefined;
}): Promise<void> {
  const { wctx, state, task, taskStartSnapshot, lineageFiles } = opts;
  try {
    const keptFiles =
      lineageFiles ??
      (taskStartSnapshot === undefined
        ? undefined
        : await getChangedFilesSinceSnapshot(wctx.workspaceDir, taskStartSnapshot));
    mutateEvidenceLedger(wctx, (existing) =>
      recordSkippedTaskEvidence({
        ledger: existing ?? loadOrCreateLedger({ ref: wctx, state }),
        task,
        reason: opts.reason,
        keptFiles,
        remainderFiles: lineageFiles,
      }),
    );
  } catch (err) {
    warnEvidenceNotSaved(wctx, state.phase, err);
  }
}

/**
 * A run that closes inside a brief books what the brief left: the ledger books a brief when an
 * attempt ends, and a stop cuts the attempt before that, while a halt can put an attempt's booked
 * files back. Without it the record would name other files than the run's changes hold. An
 * isolated workspace stays the run's until it closes, so it is read as it is. A checkout is the
 * user's once its run's process exits: that process records a snapshot as it exits, and later
 * edits and a reject change the checkout, so the brief's files are then the ones that changed up
 * to that snapshot. A process that died took no such snapshot, so its checkout, like a live one,
 * is read as it is. The close ends every lineage that is still open, also between two of its
 * briefs, so each one books its remainder (`closingLineageBrief`): the files changed since it
 * started that no other brief of the run booked.
 */
export async function persistStoppedBriefEvidence(
  ref: SessionRef,
  state: WorkflowState,
  workspace: WorkflowState['workspace'],
): Promise<void> {
  if (workspace === undefined || !existsSync(workspace.path)) return;
  if (
    workspace.kind !== 'checkout' &&
    !(await isOwnRunWorkspace(ref, { kind: workspace.kind, path: workspace.path }))
  ) {
    return;
  }
  const atRest =
    workspace.kind === 'checkout' &&
    checkSessionLockStatus({ sessionDir: sessionDir(ref.projectDir, ref.sessionId) }).kind ===
      'exited';
  const changedSince = (snapshot: ChangedFilesSnapshot) =>
    atRest
      ? changedSinceAtRest(ref, snapshot)
      : getChangedFilesSinceSnapshot(workspace.path, snapshot);
  const inFlight = briefInFlight(state);
  const taskStart = state.changedFilesBaseline?.activeTaskSnapshot;
  if (inFlight !== undefined && taskStart !== undefined) {
    const changedFiles = await changedSince(taskStart);
    mutateEvidenceLedger(ref, (existing) =>
      recordStoppedTaskEvidence({
        ledger: existing ?? loadOrCreateLedger({ ref, state }),
        task: inFlight,
        changedFiles,
      }),
    );
  }
  for (const [key, lineage] of Object.entries(state.lineages ?? {})) {
    const owner = closingLineageBrief(state, key, inFlight);
    if (lineage.startSnapshot === undefined || owner === undefined) continue;
    const files = unbookedFiles(ref, owner, await changedSince(lineage.startSnapshot));
    mutateEvidenceLedger(ref, (existing) =>
      recordRemainderEvidence({
        ledger: existing ?? loadOrCreateLedger({ ref, state }),
        task: owner,
        files,
      }),
    );
  }
}

/**
 * The brief that books an open lineage's remainder when the run closes: the brief in flight when
 * it belongs to the lineage, else the lineage's last settled brief. A stop between two split
 * children leaves no brief of the lineage in flight.
 */
function closingLineageBrief(
  state: WorkflowState,
  key: string,
  inFlight: Task | undefined,
): Task | undefined {
  if (inFlight !== undefined && lineageIdOf(inFlight) === key) return inFlight;
  return state.tasks
    .filter((task) => lineageIdOf(task) === key && isTaskSettled(task.status))
    .at(-1);
}

/** A checkout attempt is put back before recovery; an isolated attempt keeps its partial output. */
export async function raiseApiApplyRecovery(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  result: Extract<BundleApplyResult, { status: 'partial' | 'failed' }>;
  workspace: AttemptWorkspace;
}): Promise<WorkflowState> {
  const { wctx, state, task, result, workspace } = opts;
  const workspacePath = workspace.projectDir;
  const inPlace = state.workspace?.kind === 'checkout';
  if (inPlace) {
    await workspace.revert();
  }
  const landed = result.applied.map((file) => file.path).join(', ');
  const message =
    result.status === 'partial'
      ? `${task.id}: the response stopped at ${result.failedPath} after applying ${landed}; ${inPlace ? 'partial changes put back in your checkout' : 'partial changes kept in the run workspace'}, and the brief did not advance (${result.error})`
      : inPlace
        ? `${task.id}: the outcome of writing ${result.failedPath} was uncertain; the attempt changes were put back in your checkout (${result.error})`
        : `${task.id}: the outcome of writing ${result.failedPath} is uncertain in the run workspace; reconcile this file before continuing (${result.error})`;
  publishError({ bus: wctx.bus, phase: state.phase, message });
  return raisePendingRecovery(
    wctx,
    state,
    createRecoveryIssue({
      reason: 'implementation-error',
      phase: state.phase,
      seat: 'build',
      task,
      files: [...result.applied.map((file) => file.path), result.failedPath],
      affectedTaskIds: [task.id],
      message,
      details: [
        inPlace
          ? `The partial writes were put back to the attempt start in your checkout. ${replacedFilesSavedIn(revertedDir(wctx))}.`
          : `The partial writes stay in the run workspace at ${workspacePath}; the checkout is unchanged.`,
      ],
      facts: { apiApplyIncomplete: true, workspacePath },
      availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
      recommendedAction: 'retry-same-worker',
      createdAt: nowIso(),
    }),
  );
}
