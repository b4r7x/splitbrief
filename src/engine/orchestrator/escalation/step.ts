import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { formatValidationError } from '../validation.js';
import type { WorkflowContext } from '../types.js';
import { refreshAndPersistCode, addUsageAndSave } from '../state-ops.js';
import { validateCommitAndAdvance } from '../task-commit.js';
import type { UsageCategory } from '../tokens.js';
import {
  captureCurrentFileContents,
  createStagedProject,
  gateChangedFiles,
  getChangedFilesSinceSnapshot,
  promoteStagedChanges,
  restoreDirtyFilesFromSnapshot,
  type ChangedFilesSnapshot,
  type GateDecision,
} from '../tiered-approval.js';
import { publishError } from '../events.js';
import {
  createEvidenceLedger,
  readEvidenceLedger,
  recordApprovalEvidence,
  recordRejectionEvidence,
  writeEvidenceLedger,
} from '../evidence.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';

export const MAX_HINT_ERROR_LENGTH = 4000;

export type RetryResult =
  | { completed: true; method: Exclude<TaskCompletionMethod, 'failed' | 'skipped'>; attempts: number }
  | { completed: false; method: 'failed'; attempts: number };

export type EscalationContext = WorkflowContext & {
  taskStartTime?: number | undefined;
  taskStartSnapshot: ChangedFilesSnapshot;
  dependsOnFiles: string[];
};

export type RetryStepOutcome = {
  state: WorkflowState;
  task: Task;
  lastError: string;
  attempts: number;
  result?: RetryResult;
};

export type SuccessMethod = Exclude<TaskCompletionMethod, 'failed' | 'skipped'>;

export type RetryStepOpts = {
  ctx: EscalationContext;
  task: Task;
  state: WorkflowState;
  lastError: string;
  attempts: number;
  method: SuccessMethod;
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS';
  commitSuffix?: string | undefined;
  usageCategory: UsageCategory;
  retryFailureFallback: string;
  invokeRetry: (args: { task: Task; lastError: string; attempts: number; projectDir: string }) => Promise<{ success: boolean; error?: string | undefined; usage?: TokenDelta | null | undefined }>;
  onValidationAfterRetryFail?: ((validationError: string) => void) | undefined;
};

export async function validateAndCommit(
  ctx: EscalationContext, task: Task, state: WorkflowState,
  method: TaskCompletionMethod,
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS',
  retryCount: number,
  commitSuffix?: string,
  preApprovedChangedFiles?: string[],
) {
  let changedFiles: string[];
  try {
    changedFiles = preApprovedChangedFiles ?? await getChangedFilesSinceSnapshot(ctx.projectDir, ctx.taskStartSnapshot);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    publishError(ctx.bus, state.phase, `Retry changed files blocked by approval gate: ${reason}`);
    return {
      state,
      completed: false,
      validationResults: [],
      blockedReason: reason,
    };
  }
  if (preApprovedChangedFiles === undefined) {
    const preApprovalChangedFileContents = captureCurrentFileContents(ctx.projectDir, changedFiles);
    const changedFilesGate = await gateChangedFiles({
      changedFiles,
      task,
      dependsOnFiles: ctx.dependsOnFiles,
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
      phase: state.phase,
      taskId: task.id,
      bus: ctx.bus,
      callbacks: ctx.callbacks,
      config: ctx.config,
    });
    if (!changedFilesGate.allow) {
      const files = changedFilesGate.changedFiles.join(', ');
      const reason = changedFilesGate.reason ?? 'denied';
      try {
        const restoreResult = await restoreDirtyFilesFromSnapshot(
          ctx.projectDir,
          ctx.taskStartSnapshot,
          changedFilesGate.changedFiles,
          preApprovalChangedFileContents,
        );
        if (restoreResult.conflictedFiles.length > 0) {
          publishError(
            ctx.bus,
            state.phase,
            `Denied retry rollback skipped files changed during approval: ${restoreResult.conflictedFiles.join(', ')}`,
          );
        }
      } catch (err) {
        publishError(ctx.bus, state.phase, `Failed to discard denied retry changes: ${err instanceof Error ? err.message : String(err)}`);
      }
      publishError(ctx.bus, state.phase, `Retry changed files blocked by approval gate: ${reason} (${files})`);
      persistRetryRejectionEvidence(ctx, state, task, changedFilesGate);
      return {
        state,
        completed: false,
        validationResults: [],
        blockedReason: reason,
      };
    }
    persistRetryApprovalEvidence(ctx, state, task, changedFilesGate);
  }

  const validationResults = await ctx.validator.runValidation(task, ctx.projectDir, ctx.config, ctx.bus, state.phase, task.id);
  const result = await validateCommitAndAdvance({
    task, projectDir: ctx.projectDir, sessionId: ctx.sessionId,
    config: ctx.config, bus: ctx.bus,
    state, method, transitionType, commitSuffix,
    taskStartTime: ctx.taskStartTime, retryCount,
    results: validationResults,
  });
  return { ...result, validationResults };
}

function persistRetryApprovalEvidence(
  ctx: EscalationContext,
  state: WorkflowState,
  task: Task,
  decision: GateDecision,
): void {
  if (!decision.confirmApprovals || decision.confirmApprovals.length === 0) return;
  try {
    const existing = readEvidenceLedger(ctx.projectDir, ctx.sessionId);
    let ledger = existing ?? createEvidenceLedger({
      sessionId: ctx.sessionId,
      feature: state.feature,
      mode: ctx.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      tasks: state.tasks,
    });
    for (const approval of decision.confirmApprovals) {
      ledger = recordApprovalEvidence({
        ledger,
        tier: approval.tier,
        actionClass: approval.actionClass,
        actionDescription: approval.actionDescription,
        taskId: task.id,
        reason: approval.reason,
      });
    }
    writeEvidenceLedger(ctx.projectDir, ctx.sessionId, ledger);
  } catch {
    // Approval evidence is best-effort; the approval decision already allowed the retry.
  }
}

function persistRetryRejectionEvidence(
  ctx: EscalationContext,
  state: WorkflowState,
  task: Task,
  decision: GateDecision,
): void {
  const rejectedTier = decision.tier;
  if (!rejectedTier || rejectedTier === 'auto' || !decision.actionClass || !decision.actionDescription) return;
  try {
    const existing = readEvidenceLedger(ctx.projectDir, ctx.sessionId);
    const ledger = existing ?? createEvidenceLedger({
      sessionId: ctx.sessionId,
      feature: state.feature,
      mode: ctx.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      tasks: state.tasks,
    });
    const updated = recordRejectionEvidence({
      ledger,
      tier: rejectedTier,
      actionClass: decision.actionClass,
      actionDescription: decision.actionDescription,
      taskId: task.id,
      reason: decision.reason ?? 'denied',
    });
    writeEvidenceLedger(ctx.projectDir, ctx.sessionId, updated);
  } catch {
    // Rejection evidence is best-effort; the approval decision already blocked the task.
  }
}

/**
 * Shared retry step: refresh code → invoke retry → record usage → (on success) validate+commit.
 * Callers provide tier-specific inputs (method, usage category, commit suffix, retry invocation).
 */
export async function runRetryStep(opts: RetryStepOpts): Promise<RetryStepOutcome> {
  const { ctx, state: initialState, lastError, attempts, method, transitionType, commitSuffix, usageCategory, retryFailureFallback, invokeRetry, onValidationAfterRetryFail } = opts;
  let state = initialState;
  let task = opts.task;

  ({ task, state } = await refreshAndPersistCode(task, ctx.projectDir, ctx.sessionId, state));

  const staged = await createStagedProject(ctx.projectDir);
  let retryResult: Awaited<ReturnType<typeof invokeRetry>>;
  try {
    retryResult = await invokeRetry({ task, lastError, attempts, projectDir: staged.projectDir });
  } catch (err) {
    staged.cleanup();
    throw err;
  }
  state = addUsageAndSave(ctx.projectDir, ctx.sessionId, state, usageCategory, retryResult.usage, ctx.bus);

  if (!retryResult.success) {
    staged.cleanup();
    return { state, task, lastError: retryResult.error ?? retryFailureFallback, attempts };
  }

  const stagedChangedFiles = await getChangedFilesSinceSnapshot(staged.projectDir, ctx.taskStartSnapshot);
  const actualChangedFiles = stagedChangedFiles.length > 0
    ? stagedChangedFiles
    : await getChangedFilesSinceSnapshot(ctx.projectDir, ctx.taskStartSnapshot);
  const preApprovalChangedFileContents = captureCurrentFileContents(ctx.projectDir, actualChangedFiles);
  const changedFilesGate = await gateChangedFiles({
    changedFiles: actualChangedFiles,
    task,
    dependsOnFiles: ctx.dependsOnFiles,
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    phase: state.phase,
    taskId: task.id,
    bus: ctx.bus,
    callbacks: ctx.callbacks,
    config: ctx.config,
  });
  if (!changedFilesGate.allow) {
    const files = changedFilesGate.changedFiles.join(', ');
    const reason = changedFilesGate.reason ?? 'denied';
    if (stagedChangedFiles.length === 0 && actualChangedFiles.length > 0) {
      await restoreDirtyFilesFromSnapshot(
        ctx.projectDir,
        ctx.taskStartSnapshot,
        actualChangedFiles,
        preApprovalChangedFileContents,
      );
    }
    publishError(ctx.bus, state.phase, `Retry changed files blocked by approval gate: ${reason} (${files})`);
    persistRetryRejectionEvidence(ctx, state, task, changedFilesGate);
    staged.cleanup();
    return {
      state,
      task,
      lastError: reason,
      attempts,
      result: { completed: false, method: 'failed', attempts },
    };
  }
  persistRetryApprovalEvidence(ctx, state, task, changedFilesGate);

  if (stagedChangedFiles.length > 0) {
    const promoted = promoteStagedChanges(ctx.projectDir, staged.projectDir, stagedChangedFiles, preApprovalChangedFileContents);
    if (promoted.conflictedFiles.length > 0) {
      const reason = `Approved retry promotion blocked because files changed during approval: ${promoted.conflictedFiles.join(', ')}`;
      publishError(
        ctx.bus,
        state.phase,
        reason,
      );
      staged.cleanup();
      return {
        state,
        task,
        lastError: reason,
        attempts,
        result: { completed: false, method: 'failed', attempts },
      };
    }
  }
  staged.cleanup();

  const commitResult = await validateAndCommit(ctx, task, state, method, transitionType, attempts, commitSuffix, actualChangedFiles);
  if ('blockedReason' in commitResult) {
    return {
      state: commitResult.state,
      task,
      lastError: commitResult.blockedReason,
      attempts,
      result: { completed: false, method: 'failed', attempts },
    };
  }
  if (commitResult.completed) {
    return {
      state: commitResult.state,
      task,
      lastError,
      attempts,
      result: { completed: true, method, attempts },
    };
  }

  const validationError = formatValidationError(commitResult.validationResults);
  onValidationAfterRetryFail?.(validationError);
  return { state: commitResult.state, task, lastError: validationError, attempts };
}
