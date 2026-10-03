import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { OrchestratorCallbacks } from '../types.js';
import {
  gateChangedFiles,
  type GateChangedFilesDecision,
  type GateChangedFilesDenial,
} from './gate-files.js';
import { getChangedFilesSinceSnapshot } from './file-snapshots/capture.js';
import { restoreDirtyFilesFromSnapshot } from './file-snapshots/restore.js';
import { promoteStagedChanges, stagedProjectError } from './staged-project.js';
import { readConfinedEntry, type FileSnapshotEntry } from './file-snapshots/entry.js';
import { pathConfinementError } from '../../../lib/path-confinement.js';
import {
  persistPromotedFilesEvidence,
  persistPromotionFailureEvidence,
  invalidateTargetWriteEvidence,
} from '../evidence/persistence.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import { capturePromotedReviewChanges } from '../evidence/review-capture.js';
import type { EvidencePromotedFile } from '../../../core/schemas/evidence.js';
import type { IsolatedWorkspace } from '../isolation/types.js';
import { createRecoveryIssue } from '../recovery/builders/issue.js';
import { raisePendingRecovery } from '../state-ops.js';
import { isAbortError } from '../../../utils/abort.js';
import { isResumableWorkspaceStop } from '../isolation/retention.js';
import { error } from '../../../utils/error.js';

export type GateDenial = {
  decision: GateChangedFilesDenial;
  /** The writes the denial actually removed; a file changed during the prompt is kept. */
  discardedFiles: string[];
};

export type GateAndPromoteOutcome =
  | {
      outcome: 'allow';
      state: WorkflowState;
      /** The files that went ahead; a denied file is never among them. */
      changedFiles: string[];
      /** Set when the gate denied some files and let the rest through. */
      denial?: GateDenial;
    }
  | { outcome: 'gate-denied'; state: WorkflowState; denial: GateDenial }
  | { outcome: 'promote-conflict'; state: WorkflowState; conflictedFiles: string[] }
  | { outcome: 'aborted'; state: WorkflowState }
  | {
      outcome: 'error';
      state: WorkflowState;
      error: unknown;
      promotion?: PartialPromotionDetail;
    };

/** What a promotion actually put on the target before it stopped. */
export type PartialPromotionDetail = {
  appliedFiles: EvidencePromotedFile[];
  failedFile: string;
  error: unknown;
  /** Set when the durable record of this partial apply could not be written. */
  evidenceError?: unknown;
  workspaceRetained: boolean;
};

export type GateAndPromoteOpts = {
  task: Task;
  state: WorkflowState;
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  callbacks: OrchestratorCallbacks;
  config: Config;
  getApprovalEnabled?: (() => boolean) | undefined;
  workspace: IsolatedWorkspace | undefined;
  taskStartSnapshot: ChangedFilesSnapshot;
  dependsOnFiles: string[];
  preApprovedFiles?: string[];
  catchChangedFilesError?: boolean;
  signal?: AbortSignal | undefined;
  cleanup?: (() => void) | undefined;
  handleConflict: (state: WorkflowState, files: string[]) => Promise<WorkflowState>;
  onRestoreConflict?: ((files: string[]) => void) | undefined;
  onRestoreError?: ((err: unknown) => void) | undefined;
  onApproved: (decision: GateChangedFilesDecision) => void;
};

/**
 * The row a denial shows. A blocked attempt went nowhere; otherwise only the denied files were
 * dropped and the rest went ahead. Either way it names what was actually discarded.
 */
export function denialMessage(input: {
  subject: string;
  denial: GateDenial;
  blocked: boolean;
}): string {
  const { decision, discardedFiles } = input.denial;
  const reason = decision.reason ?? 'denied';
  const lead = input.blocked
    ? `${input.subject} changed files blocked by approval gate: ${reason}.`
    : `Approval gate denied ${decision.deniedFiles.join(', ')}: ${reason}.`;
  const discarded =
    discardedFiles.length === 0
      ? "SPLITBRIEF discarded none of this attempt's writes."
      : `SPLITBRIEF discarded this attempt's writes to ${discardedFiles.join(', ')}.`;
  return `${lead} ${discarded}`;
}

const gateAndPromoteError = {
  missingFailedFile: () =>
    error('approval-promotion-invariant', 'Stopped promotion has no failed file.'),
} as const;

export async function gateAndPromoteChangedFiles(
  opts: GateAndPromoteOpts,
): Promise<GateAndPromoteOutcome> {
  const {
    task,
    projectDir,
    sessionId,
    bus,
    callbacks,
    config,
    getApprovalEnabled,
    workspace,
    taskStartSnapshot,
    dependsOnFiles,
    signal,
    cleanup,
    handleConflict,
    onRestoreConflict,
    onRestoreError,
    onApproved,
  } = opts;
  let state = opts.state;
  const preApprovedFiles = opts.preApprovedFiles ?? [];
  let isUnwindingPrimaryError = false;
  let retainWorkspaceOutput = false;

  try {
    let changedFiles: string[];
    try {
      // An isolated worker's changes are its workspace's alone. The checkout
      // changing during the call is the operator's, which the implementer's
      // per-call audit reports and never attributes to the brief.
      changedFiles = await getChangedFilesSinceSnapshot(
        workspace?.projectDir ?? projectDir,
        workspace?.snapshot ?? taskStartSnapshot,
      );
    } catch (err) {
      if (!opts.catchChangedFilesError) throw err;
      return { outcome: 'error', state, error: err };
    }

    // Restoration material for a denied direct write, and nothing else: it is
    // read after the worker ran, so promotion answers to the workspace's own
    // acquisition baseline instead.
    const preApprovalEntries = new Map<string, FileSnapshotEntry>();
    await Promise.all(
      changedFiles.map(async (file) => {
        try {
          preApprovalEntries.set(file, await readConfinedEntry(projectDir, file));
        } catch (err) {
          // A symlink in the target is never promoted: promotion raises it as a
          // conflict, so an isolated worker's path there has no entry to keep.
          if (workspace === undefined || !pathConfinementError.isSymlinkRead(err)) throw err;
        }
      }),
    );
    const preApprovedFileSet = new Set(preApprovedFiles);
    const filesNeedingApproval = changedFiles.filter((file) => !preApprovedFileSet.has(file));

    let decision: GateChangedFilesDecision = { allow: true, changedFiles };
    if (filesNeedingApproval.length > 0) {
      decision = await gateChangedFiles({
        changedFiles: filesNeedingApproval,
        task,
        dependsOnFiles,
        projectDir,
        sessionId,
        phase: state.phase,
        taskId: task.id,
        bus,
        callbacks,
        config,
        getApprovalEnabled,
        signal,
      });
    }

    if (signal?.aborted) {
      if (workspace !== undefined && isResumableWorkspaceStop(signal)) {
        retainWorkspaceOutput = true;
        await workspace.retain?.();
      }
      return { outcome: 'aborted', state };
    }

    let denial: GateDenial | undefined;
    if (!decision.allow) {
      const { deniedFiles } = decision;
      const allowedFiles = decision.changedFiles.filter((file) => !deniedFiles.includes(file));
      let discardedFiles = workspace === undefined ? [] : deniedFiles;
      let halted = false;
      try {
        if (workspace === undefined) {
          const restore = (files: string[]) =>
            restoreDirtyFilesFromSnapshot(
              projectDir,
              taskStartSnapshot,
              files,
              {},
              preApprovalEntries,
            );
          const deniedResult = await restore(deniedFiles);
          discardedFiles = deniedResult.restoredFiles;
          if (deniedResult.conflictedFiles.length > 0) {
            // The conflict halts the attempt, so the writes the gate allowed do not go ahead either.
            const allowedResult = await restore(allowedFiles);
            discardedFiles = [...discardedFiles, ...allowedResult.restoredFiles];
            const conflictedFiles = [
              ...deniedResult.conflictedFiles,
              ...allowedResult.conflictedFiles,
            ];
            halted = true;
            state = await handleConflict(state, conflictedFiles);
            onRestoreConflict?.(conflictedFiles);
          }
        }
      } catch (err) {
        if (onRestoreError === undefined) throw err;
        halted = true;
        onRestoreError(err);
      }
      changedFiles = changedFiles.filter((file) => !deniedFiles.includes(file));
      denial = { decision, discardedFiles };
      if (halted || changedFiles.length === 0) return { outcome: 'gate-denied', state, denial };
    }

    if (filesNeedingApproval.length > 0) {
      onApproved(decision);
    }

    if (workspace !== undefined) {
      let promoteResult: Awaited<ReturnType<typeof promoteStagedChanges>>;
      try {
        invalidateTargetWriteEvidence({
          ref: { projectDir, sessionId },
          task,
          files: changedFiles,
        });
        promoteResult = await promoteStagedChanges({
          targetProjectDir: projectDir,
          stagedProjectDir: workspace.projectDir,
          files: changedFiles,
          targetBaseline: workspace.targetBaseline,
        });
      } catch (err) {
        retainWorkspaceOutput = true;
        return { outcome: 'error', state, error: err };
      }
      await capturePromotedReviewChanges({
        ref: { projectDir, sessionId },
        task,
        files: promoteResult.appliedFiles ?? [],
        before: preApprovalEntries,
        baseline: workspace.targetBaseline,
      });
      // A partial apply never reaches an allow decision: the failure detail names
      // the file the target stopped at, with the prefix already written.
      const partialConflict =
        promoteResult.promotedFiles.length > 0 && promoteResult.conflictedFiles.length > 0;
      if (promoteResult.failure !== undefined || partialConflict) {
        // The workspace still holds the part of the worker's output that never
        // reached the target, so the gate does not dispose of it here.
        retainWorkspaceOutput = true;
        const failedFile = promoteResult.failure?.failedFile ?? promoteResult.conflictedFiles[0];
        if (failedFile === undefined) throw gateAndPromoteError.missingFailedFile();
        const promotionError =
          promoteResult.failure?.error ?? stagedProjectError.conflict(failedFile);
        const appliedFiles = promoteResult.appliedFiles ?? [];
        const persisted = persistPromotionFailureEvidence({
          ref: { projectDir, sessionId },
          state,
          task,
          attempt: {
            ts: nowIso(),
            appliedFiles,
            failedFile,
            error: toErrorMessage(promotionError),
          },
        });
        const promotion: PartialPromotionDetail = {
          appliedFiles,
          failedFile,
          error: promotionError,
          workspaceRetained: true,
          ...(persisted.persisted ? {} : { evidenceError: persisted.error }),
        };
        const issue = createRecoveryIssue({
          reason: 'approval-promotion-conflict',
          phase: state.phase,
          task,
          files: [...promoteResult.promotedFiles, failedFile],
          affectedTaskIds: [task.id],
          message: `Promotion stopped for ${task.id} at ${failedFile}`,
          details: [
            `${appliedFiles.length} file(s) applied; remaining worker output retained at ${workspace.projectDir}.`,
            toErrorMessage(promotionError),
            'Retry captures a fresh target baseline and preserves already applied files.',
          ],
          facts: { partialPromotion: true, workspacePath: workspace.projectDir },
          availableActions: ['retry-same-worker', 'pause-run', 'end-run'],
          recommendedAction: 'pause-run',
          createdAt: nowIso(),
        });
        try {
          state = raisePendingRecovery({ projectDir, sessionId, bus }, state, issue);
        } catch (recoveryError) {
          state = { ...state, pendingRecovery: issue };
          return {
            outcome: 'error',
            state,
            promotion,
            error: new AggregateError(
              [promotionError, ...(persisted.persisted ? [] : [persisted.error]), recoveryError],
              `Promotion stopped and recovery could not be persisted: ${toErrorMessage(recoveryError)}`,
            ),
          };
        }
        if (persisted.persisted) {
          return { outcome: 'error', state, error: promotionError, promotion };
        }
        return {
          outcome: 'error',
          state,
          error: new AggregateError(
            [promotionError, persisted.error],
            `promotion stopped at ${failedFile} and its evidence could not be persisted: ${toErrorMessage(persisted.error)}`,
          ),
          promotion,
        };
      }
      if (promoteResult.conflictedFiles.length > 0) {
        retainWorkspaceOutput = true;
        state = await handleConflict(state, promoteResult.conflictedFiles);
        return {
          outcome: 'promote-conflict',
          state,
          conflictedFiles: promoteResult.conflictedFiles,
        };
      }
      if ((promoteResult.appliedFiles?.length ?? 0) > 0) {
        persistPromotedFilesEvidence({
          ref: { projectDir, sessionId },
          bus,
          state,
          task,
          files: promoteResult.appliedFiles ?? [],
        });
      }
    }

    return { outcome: 'allow', state, changedFiles, ...(denial === undefined ? {} : { denial }) };
  } catch (err) {
    if (workspace !== undefined && isAbortError(err) && isResumableWorkspaceStop(signal)) {
      retainWorkspaceOutput = true;
      await workspace.retain?.();
    }
    isUnwindingPrimaryError = true;
    throw err;
  } finally {
    if (!retainWorkspaceOutput) {
      if (isUnwindingPrimaryError) {
        try {
          cleanup?.();
        } catch {
          // Cleanup is best-effort while preserving the primary operation error.
        }
      } else {
        cleanup?.();
      }
    }
  }
}
