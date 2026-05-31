import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { publishError, publishWarning, publishWarningFromError } from '../events.js';
import type { ChangedFilesSnapshot } from '../approval/file-snapshots.js';
import type { StagedProject } from '../approval/staged-project.js';
import type { GateDecision } from '../approval/tiered-approval.js';
import { gateAndPromoteChangedFiles } from '../approval/gate-and-promote.js';
import { persistApprovalEvidence } from '../evidence/persistence.js';
import { resolveDependsOnFiles } from './resolve-deps.js';

export type ApplyChangedFilesResult =
  | { proceed: true; state: WorkflowState; taskChangedFiles: string[] }
  | { proceed: false; state: WorkflowState };

export async function applyChangedFiles(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  staged: StagedProject | undefined;
  usesStaging: boolean;
  preApplyApprovedFiles: string[];
  taskStartSnapshot: ChangedFilesSnapshot;
  recordApprovalDenial: (state: WorkflowState, decision: GateDecision, message: string) => void;
  handleConflict: (state: WorkflowState, files: string[]) => Promise<WorkflowState>;
}): Promise<ApplyChangedFilesResult> {
  const { wctx, task, staged, usesStaging, preApplyApprovedFiles, taskStartSnapshot } = opts;
  const { projectDir, sessionId, config, callbacks } = wctx;
  const state = opts.state;

  const result = await gateAndPromoteChangedFiles({
    task,
    state,
    projectDir,
    sessionId,
    bus: wctx.bus,
    callbacks,
    config,
    staged,
    usesStaging,
    taskStartSnapshot,
    dependsOnFiles: resolveDependsOnFiles(state.tasks, task),
    preApprovedFiles: preApplyApprovedFiles,
    signal: wctx.signal,
    cleanup: staged ? () => staged.cleanup() : undefined,
    catchChangedFilesError: true,
    handleConflict: opts.handleConflict,
    onRestoreConflict: (files) =>
      publishWarning(
        { bus: wctx.bus, phase: state.phase },
        `denied task rollback skipped files changed during approval: ${files.join(', ')}`,
      ),
    onRestoreError: (err) =>
      publishWarningFromError(
        { bus: wctx.bus, phase: state.phase },
        'failed to discard denied task changes',
        err,
      ),
    onApproved: (decision) => persistApprovalEvidence({ wctx, state, decision, taskId: task.id }),
  });

  if (result.outcome === 'error') {
    publishError(
      { bus: wctx.bus, phase: state.phase },
      `Task changed files blocked by approval gate: ${toErrorMessage(result.error)}`,
    );
    return { proceed: false, state: result.state };
  }
  if (result.outcome === 'gate-denied') {
    const files = result.decision.changedFiles.join(', ');
    opts.recordApprovalDenial(
      result.state,
      result.decision,
      `Task changed files blocked by approval gate: ${result.decision.reason ?? 'denied'} (${files})`,
    );
    return { proceed: false, state: result.state };
  }
  if (result.outcome === 'promote-conflict') {
    publishError(
      { bus: wctx.bus, phase: result.state.phase },
      `Approved task promotion blocked because files changed during approval: ${result.conflictedFiles.join(', ')}`,
    );
    return { proceed: false, state: result.state };
  }
  if (result.outcome === 'aborted') {
    return { proceed: false, state: result.state };
  }

  return { proceed: true, state: result.state, taskChangedFiles: result.changedFiles };
}
