import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { OrchestratorCallbacks } from '../types.js';
import { gateChangedFiles, type GateChangedFilesDecision } from './gate-files.js';
import { getChangedFilesSinceSnapshot } from './file-snapshots/capture.js';
import { restoreDirtyFilesFromSnapshot } from './file-snapshots/restore.js';
import { promoteStagedChanges, stagedProjectError } from './staged-project.js';
import { readConfinedEntry } from './file-snapshots/entry.js';
import { persistPromotionFailureEvidence } from '../evidence/persistence.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import type { EvidencePromotedFile } from '../../../core/schemas/evidence.js';
import type { IsolatedWorkspace } from '../isolation/types.js';
import { createRecoveryIssue } from '../recovery/builders/issue.js';
import { raisePendingRecovery } from '../state-ops.js';
import { error } from '../../../utils/error.js';

export type GateAndPromoteOutcome =
  | { outcome: 'allow'; state: WorkflowState; changedFiles: string[] }
  | { outcome: 'gate-denied'; state: WorkflowState; decision: GateChangedFilesDecision }
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
    const preApprovalEntries = new Map(
      await Promise.all(
        changedFiles.map(
          async (file) => [file, await readConfinedEntry(projectDir, file)] as const,
        ),
      ),
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
      });
    }

    if (signal?.aborted) {
      return { outcome: 'aborted', state };
    }

    if (!decision.allow) {
      try {
        if (workspace === undefined) {
          const restoreResult = await restoreDirtyFilesFromSnapshot(
            projectDir,
            taskStartSnapshot,
            decision.changedFiles,
            {},
            preApprovalEntries,
          );
          if (restoreResult.conflictedFiles.length > 0) {
            state = await handleConflict(state, restoreResult.conflictedFiles);
            onRestoreConflict?.(restoreResult.conflictedFiles);
          }
        }
      } catch (err) {
        if (onRestoreError === undefined) throw err;
        onRestoreError(err);
      }
      return { outcome: 'gate-denied', state, decision };
    }

    if (filesNeedingApproval.length > 0) {
      onApproved(decision);
    }

    if (workspace !== undefined) {
      let promoteResult: Awaited<ReturnType<typeof promoteStagedChanges>>;
      try {
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
          mode: config.workflow.mode,
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
    }

    return { outcome: 'allow', state, changedFiles };
  } catch (err) {
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
