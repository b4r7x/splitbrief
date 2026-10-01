import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { publishError, publishWarning, publishWarningFromError } from '../events.js';
import type { IsolatedWorkspace } from '../isolation/types.js';
import type { GateChangedFilesDenial } from '../approval/gate-files.js';
import { denialMessage, gateAndPromoteChangedFiles } from '../approval/gate-and-promote.js';
import { persistApprovalEvidence } from '../evidence/persistence.js';
import { resolveDependsOnFiles } from './resolve-deps.js';
import { raisePendingRecovery } from '../state-ops.js';
import { buildApprovalDeniedRecoveryIssue } from '../recovery/builders/task.js';
import { getRunnerDisplayName } from '../../../core/config/accessors/runner-config.js';
import { nowIso } from '../../../utils/format-time.js';

export type ApplyChangedFilesResult =
  | { proceed: true; state: WorkflowState; taskChangedFiles: string[] }
  | { proceed: false; state: WorkflowState };

export async function applyChangedFiles(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  workspace: IsolatedWorkspace | undefined;
  preApplyApprovedFiles: string[];
  taskStartSnapshot: ChangedFilesSnapshot;
  recordApprovalDenial: (
    state: WorkflowState,
    decision: GateChangedFilesDenial,
    message: string,
  ) => void;
  handleConflict: (state: WorkflowState, files: string[]) => Promise<WorkflowState>;
}): Promise<ApplyChangedFilesResult> {
  const { wctx, task, workspace, preApplyApprovedFiles, taskStartSnapshot } = opts;
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
    getApprovalEnabled: wctx.getApprovalEnabled,
    workspace,
    taskStartSnapshot,
    dependsOnFiles: resolveDependsOnFiles(state.tasks, task),
    preApprovedFiles: preApplyApprovedFiles,
    signal: wctx.signal,
    cleanup: workspace ? () => workspace.cleanup() : undefined,
    catchChangedFilesError: true,
    handleConflict: opts.handleConflict,
    onRestoreConflict: (files) =>
      publishWarning({
        bus: wctx.bus,
        phase: state.phase,
        message: `denied task rollback skipped files changed during approval: ${files.join(', ')}`,
      }),
    onRestoreError: (err) =>
      publishWarningFromError(
        { bus: wctx.bus, phase: state.phase },
        'failed to discard denied task changes',
        err,
      ),
    onApproved: (decision) => persistApprovalEvidence({ wctx, state, decision, taskId: task.id }),
  });

  if (result.outcome === 'error') {
    publishError({
      bus: wctx.bus,
      phase: state.phase,
      message: `Task changed files blocked by approval gate: ${toErrorMessage(result.error)}`,
    });
    return { proceed: false, state: result.state };
  }
  const denial =
    result.outcome === 'gate-denied' || result.outcome === 'allow' ? result.denial : undefined;
  if (denial !== undefined) {
    opts.recordApprovalDenial(
      result.state,
      denial.decision,
      denialMessage({ subject: 'Task', denial, blocked: result.outcome === 'gate-denied' }),
    );
  }
  if (result.outcome === 'gate-denied') {
    // Nothing of the attempt went ahead, so the run halts and asks, as a denial before the brief does.
    if (result.state.pendingRecovery !== undefined) return { proceed: false, state: result.state };
    const { decision } = result.denial;
    const issue = buildApprovalDeniedRecoveryIssue({
      task,
      phase: result.state.phase,
      deniedFiles: decision.deniedFiles,
      ...(decision.reason !== undefined && { denialReason: decision.reason }),
      tool: getRunnerDisplayName(config.implementer),
      createdAt: nowIso(),
    });
    return { proceed: false, state: raisePendingRecovery(wctx, result.state, issue) };
  }
  if (result.outcome === 'promote-conflict') {
    publishError({
      bus: wctx.bus,
      phase: result.state.phase,
      message: `Approved task promotion blocked because files changed during approval: ${result.conflictedFiles.join(', ')}`,
    });
    return { proceed: false, state: result.state };
  }
  if (result.outcome === 'aborted') {
    return { proceed: false, state: result.state };
  }

  return { proceed: true, state: result.state, taskChangedFiles: result.changedFiles };
}
