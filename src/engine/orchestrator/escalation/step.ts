import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { Config } from '../../../core/schemas/config.js';
import type { Implementer } from '../../implementers/types.js';
import { configError } from '../../../core/config/errors.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import { resolveImplementerProfiles, type ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { saveState } from '../../../core/state/persistence.js';
import { formatValidationError } from '../validation.js';
import type { WorkflowContext } from '../types.js';
import { refreshAndPersistCode, addUsageAndSave, transitionAndSave } from '../state-ops.js';
import { validateCommitAndAdvance } from '../task/commit.js';
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
} from '../approval/tiered-approval.js';
import { createImplementerPublisher, publishError, publishRecoveryPrompted, publishUserEditConflict } from '../events.js';
import {
  createEvidenceLedger,
  readEvidenceLedger,
  recordApprovalEvidence,
  recordRejectionEvidence,
  writeEvidenceLedger,
} from '../evidence/evidence.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import { createApprovalPromotionConflict } from '../user-edit/conflicts.js';
import { buildApprovalPromotionConflictRecoveryIssue } from '../recovery/recovery.js';
import { createImplementer } from '../../runners/factory.js';

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

export type RetryInvokeArgs = {
  task: Task;
  lastError: string;
  attempts: number;
  projectDir: string;
  config: Config;
  implementer: Implementer;
  implementerProfile?: string | undefined;
};

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
  profileOverride?: string | undefined;
  invokeRetry: (args: RetryInvokeArgs) => Promise<{ success: boolean; error?: string | undefined; usage?: TokenDelta | null | undefined }>;
  onValidationAfterRetryFail?: ((validationError: string) => void) | undefined;
};

type RetryRuntime = {
  config: Config;
  implementer: Implementer;
  implementerProfile?: string | undefined;
  profile?: ResolvedImplementerProfile | undefined;
};

function retryConfigForProfile(config: Config, profile: ResolvedImplementerProfile): Config {
  return { ...config, implementer: profile.config };
}

function stateForRetryProfile(state: WorkflowState, profile: ResolvedImplementerProfile): WorkflowState {
  const { implementerModel: _previousImplementerModel, ...stateWithoutImplementerModel } = state;
  const model = getRunnerModelName(profile.config);
  return {
    ...stateWithoutImplementerModel,
    implementerTool: getRunnerDisplayName(profile.config),
    ...(model !== undefined && { implementerModel: model }),
  };
}

async function createRetryRuntime(ctx: EscalationContext, profileOverride: string | undefined): Promise<RetryRuntime> {
  if (profileOverride === undefined) {
    return {
      config: ctx.config,
      implementer: ctx.implementer,
      ...(ctx.implementerProfile !== undefined && { implementerProfile: ctx.implementerProfile }),
    };
  }

  const profile = resolveImplementerProfiles(ctx.config).profiles.find(candidate => candidate.name === profileOverride);
  if (!profile) throw configError.profileNotFound(profileOverride);

  const config = retryConfigForProfile(ctx.config, profile);
  const factory = ctx.createImplementer ?? createImplementer;
  return {
    config,
    implementer: await factory(config, { publisher: createImplementerPublisher(ctx.bus) }),
    implementerProfile: profile.name,
    profile,
  };
}

async function handleApprovalTimeUserEditConflict(opts: {
  ctx: EscalationContext;
  state: WorkflowState;
  task: Task;
  files: string[];
}): Promise<WorkflowState> {
  const conflict = createApprovalPromotionConflict({
    files: opts.files,
    currentTaskId: opts.task.id,
  });
  publishUserEditConflict(opts.ctx.bus, opts.state.phase, conflict, 'pause');
  const issue = buildApprovalPromotionConflictRecoveryIssue({
    conflict,
    currentTask: opts.task,
    phase: opts.state.phase,
    createdAt: new Date().toISOString(),
  });
  const next = transitionAndSave(opts.ctx.projectDir, opts.ctx.sessionId, opts.state, { type: 'SET_PENDING_RECOVERY', issue });
  publishRecoveryPrompted(opts.ctx.bus, issue);
  return next;
}

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
    const preApprovalChangedFileContents = await captureCurrentFileContents(ctx.projectDir, changedFiles);
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
      let nextState = state;
      try {
        const restoreResult = await restoreDirtyFilesFromSnapshot(
          ctx.projectDir,
          ctx.taskStartSnapshot,
          changedFilesGate.changedFiles,
          preApprovalChangedFileContents,
        );
        if (restoreResult.conflictedFiles.length > 0) {
          nextState = await handleApprovalTimeUserEditConflict({
            ctx,
            state,
            task,
            files: restoreResult.conflictedFiles,
          });
          publishError(
            ctx.bus,
            nextState.phase,
            `Denied retry rollback skipped files changed during approval: ${restoreResult.conflictedFiles.join(', ')}`,
          );
        }
      } catch (err) {
        publishError(ctx.bus, state.phase, `Failed to discard denied retry changes: ${err instanceof Error ? err.message : String(err)}`);
      }
      publishError(ctx.bus, nextState.phase, `Retry changed files blocked by approval gate: ${reason} (${files})`);
      persistRetryRejectionEvidence(ctx, nextState, task, changedFilesGate);
      return {
        state: nextState,
        completed: false,
        validationResults: [],
        blockedReason: reason,
      };
    }
    persistRetryApprovalEvidence(ctx, state, task, changedFilesGate);
  }

  const validationResults = await ctx.validator.runValidation(task, ctx.projectDir, ctx.config, ctx.bus, state.phase, task.id, state.discoveredValidation);
  const result = await validateCommitAndAdvance({
    task, projectDir: ctx.projectDir, sessionId: ctx.sessionId,
    config: ctx.config, bus: ctx.bus,
    state, method, transitionType, commitSuffix,
    taskStartTime: ctx.taskStartTime, retryCount,
    implementerProfile: ctx.implementerProfile,
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
  const { ctx, state: initialState, lastError, attempts, method, transitionType, commitSuffix, usageCategory, retryFailureFallback, profileOverride, invokeRetry, onValidationAfterRetryFail } = opts;
  let state = initialState;
  let task = opts.task;

  ({ task, state } = await refreshAndPersistCode(task, ctx.projectDir, ctx.sessionId, state));

  const retryRuntime = await createRetryRuntime(ctx, profileOverride);
  const retryCtx: EscalationContext = {
    ...ctx,
    config: retryRuntime.config,
    implementer: retryRuntime.implementer,
    ...(retryRuntime.implementerProfile !== undefined && { implementerProfile: retryRuntime.implementerProfile }),
  };
  if (retryRuntime.profile !== undefined) {
    state = stateForRetryProfile(state, retryRuntime.profile);
    saveState(ctx.projectDir, ctx.sessionId, state);
  }

  const staged = await createStagedProject(ctx.projectDir);
  let retryResult: Awaited<ReturnType<typeof invokeRetry>>;
  try {
    retryResult = await invokeRetry({
      task,
      lastError,
      attempts,
      projectDir: staged.projectDir,
      config: retryRuntime.config,
      implementer: retryRuntime.implementer,
      ...(retryRuntime.implementerProfile !== undefined && { implementerProfile: retryRuntime.implementerProfile }),
    });
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
  const preApprovalChangedFileContents = await captureCurrentFileContents(ctx.projectDir, actualChangedFiles);
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
    let nextState = state;
    if (stagedChangedFiles.length === 0 && actualChangedFiles.length > 0) {
      const restoreResult = await restoreDirtyFilesFromSnapshot(
        ctx.projectDir,
        ctx.taskStartSnapshot,
        actualChangedFiles,
        preApprovalChangedFileContents,
      );
      if (restoreResult.conflictedFiles.length > 0) {
        nextState = await handleApprovalTimeUserEditConflict({
          ctx,
          state,
          task,
          files: restoreResult.conflictedFiles,
        });
      }
    }
    publishError(ctx.bus, nextState.phase, `Retry changed files blocked by approval gate: ${reason} (${files})`);
    persistRetryRejectionEvidence(ctx, nextState, task, changedFilesGate);
    staged.cleanup();
    return {
      state: nextState,
      task,
      lastError: reason,
      attempts,
      result: { completed: false, method: 'failed', attempts },
    };
  }
  persistRetryApprovalEvidence(ctx, state, task, changedFilesGate);

  if (stagedChangedFiles.length > 0) {
    const promoted = await promoteStagedChanges(ctx.projectDir, staged.projectDir, stagedChangedFiles, preApprovalChangedFileContents);
    if (promoted.conflictedFiles.length > 0) {
      state = await handleApprovalTimeUserEditConflict({
        ctx,
        state,
        task,
        files: promoted.conflictedFiles,
      });
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

  const commitResult = await validateAndCommit(retryCtx, task, state, method, transitionType, attempts, commitSuffix, actualChangedFiles);
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
