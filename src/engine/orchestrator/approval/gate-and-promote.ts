import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { OrchestratorCallbacks } from '../types.js';
import { gateChangedFiles, type GateChangedFilesDecision } from './gate-files.js';
import { getChangedFilesSinceSnapshot } from './file-snapshots/capture.js';
import { captureCurrentFileContents } from './file-snapshots/contents.js';
import { restoreDirtyFilesFromSnapshot } from './file-snapshots/restore.js';
import { promoteStagedChanges } from './staged-project.js';
import type { IsolatedWorkspace } from '../isolation/types.js';

export type GateAndPromoteOutcome =
  | { outcome: 'allow'; state: WorkflowState; changedFiles: string[] }
  | { outcome: 'gate-denied'; state: WorkflowState; decision: GateChangedFilesDecision }
  | { outcome: 'promote-conflict'; state: WorkflowState; conflictedFiles: string[] }
  | { outcome: 'aborted'; state: WorkflowState }
  | { outcome: 'error'; state: WorkflowState; error: unknown };

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
  usesIsolation: boolean;
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
    usesIsolation,
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

  try {
    let changedFiles: string[];
    let fromIsolation = Boolean(workspace);
    try {
      const changedFilesSnapshot = workspace?.snapshot ?? taskStartSnapshot;
      changedFiles = await getChangedFilesSinceSnapshot(
        workspace?.projectDir ?? projectDir,
        changedFilesSnapshot,
      );
      if (usesIsolation && changedFiles.length === 0) {
        changedFiles = await getChangedFilesSinceSnapshot(projectDir, taskStartSnapshot);
        fromIsolation = false;
      }
    } catch (err) {
      if (!opts.catchChangedFilesError) throw err;
      return { outcome: 'error', state, error: err };
    }

    const preApprovalChangedFileContents = await captureCurrentFileContents(
      projectDir,
      changedFiles,
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
            preApprovalChangedFileContents,
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

    if (workspace !== undefined && fromIsolation) {
      let promoteResult: Awaited<ReturnType<typeof promoteStagedChanges>>;
      try {
        promoteResult = await promoteStagedChanges({
          targetProjectDir: projectDir,
          stagedProjectDir: workspace.projectDir,
          files: changedFiles,
          expectedCurrentContents: preApprovalChangedFileContents,
        });
      } catch (err) {
        return { outcome: 'error', state, error: err };
      }
      if (promoteResult.conflictedFiles.length > 0) {
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
