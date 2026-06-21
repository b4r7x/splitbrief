import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../events/types.js';
import type { Config } from '../../../core/schemas/config.js';
import type { OrchestratorCallbacks } from '../types.js';
import { gateChangedFiles, type GateChangedFilesDecision } from './gate-files.js';
import {
  captureCurrentFileContents,
  getChangedFilesSinceSnapshot,
  restoreDirtyFilesFromSnapshot,
  type ChangedFilesSnapshot,
} from './file-snapshots.js';
import { promoteStagedChanges, type StagedProject } from './staged-project.js';

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
  staged: StagedProject | undefined;
  usesStaging: boolean;
  taskStartSnapshot: ChangedFilesSnapshot;
  dependsOnFiles: string[];
  preApprovedFiles?: string[];
  promoteFromStagingOnly?: boolean;
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
    staged,
    usesStaging,
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

  let changedFiles: string[];
  let fromStaging = Boolean(staged);
  try {
    const changedFilesSnapshot = staged?.snapshot ?? taskStartSnapshot;
    changedFiles = await getChangedFilesSinceSnapshot(
      staged?.projectDir ?? projectDir,
      changedFilesSnapshot,
    );
    if (usesStaging && changedFiles.length === 0) {
      changedFiles = await getChangedFilesSinceSnapshot(projectDir, taskStartSnapshot);
      fromStaging = false;
    }
  } catch (err) {
    if (!opts.catchChangedFilesError) throw err;
    cleanup?.();
    return { outcome: 'error', state, error: err };
  }

  const preApprovalChangedFileContents = await captureCurrentFileContents(projectDir, changedFiles);
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
    cleanup?.();
    return { outcome: 'aborted', state };
  }

  if (!decision.allow) {
    try {
      if (!fromStaging) {
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
    cleanup?.();
    return { outcome: 'gate-denied', state, decision };
  }

  if (filesNeedingApproval.length > 0) {
    onApproved(decision);
  }

  const shouldPromote = staged !== undefined && (opts.promoteFromStagingOnly ? fromStaging : true);
  if (staged && shouldPromote) {
    let promoteResult: Awaited<ReturnType<typeof promoteStagedChanges>>;
    try {
      promoteResult = await promoteStagedChanges({
        targetProjectDir: projectDir,
        stagedProjectDir: staged.projectDir,
        files: changedFiles,
        expectedCurrentContents: preApprovalChangedFileContents,
      });
    } catch (err) {
      cleanup?.();
      return { outcome: 'error', state, error: err };
    }
    if (promoteResult.conflictedFiles.length > 0) {
      state = await handleConflict(state, promoteResult.conflictedFiles);
      cleanup?.();
      return { outcome: 'promote-conflict', state, conflictedFiles: promoteResult.conflictedFiles };
    }
  }
  cleanup?.();

  return { outcome: 'allow', state, changedFiles };
}
