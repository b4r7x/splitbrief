import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import { validateCommitAndAdvance } from '../task/commit.js';
import { runTaskChecksAfterAcceptance } from '../task/task-checks.js';
import { recordCheckRuns } from '../evidence/record-checks.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';
import type { EscalationContext } from './types.js';

const NOT_ACCEPTED_ACCEPTANCE: ValidationAcceptance = {
  accepted: false,
  exemptStages: [],
  blockingStages: [],
};

export type ValidateAndCommitOptions = {
  ctx: EscalationContext;
  task: Task;
  state: WorkflowState;
  method: TaskCompletionMethod;
  transitionType: 'VALIDATION_PASS';
  retryCount: number;
  commitSuffix?: string | undefined;
  preApprovedChangedFiles: string[];
};

export async function validateAndCommit(opts: ValidateAndCommitOptions) {
  const { ctx, task, state, method, transitionType, retryCount, commitSuffix } = opts;
  const { preApprovedChangedFiles } = opts;
  if (ctx.signal?.aborted) {
    return {
      state,
      completed: false,
      validationResults: [],
      blockedReason: 'aborted',
      acceptance: NOT_ACCEPTED_ACCEPTANCE,
    };
  }

  const validationResults = await ctx.validator.runValidation({
    task,
    projectDir: ctx.workspaceDir,
    config: ctx.config,
    bus: ctx.bus,
    phase: state.phase,
    discoveredValidation: state.discoveredValidation,
    signal: ctx.signal,
    changedFiles: preApprovedChangedFiles,
  });
  await recordCheckRuns({
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    workspaceDir: ctx.workspaceDir,
    state,
    task,
    validation: validationResults,
  });
  if (ctx.signal?.aborted) {
    return {
      state,
      completed: false,
      validationResults,
      blockedReason: 'aborted',
      acceptance: NOT_ACCEPTED_ACCEPTANCE,
    };
  }
  const acceptance = ctx.validator.decideAcceptance({
    results: validationResults,
    changedFiles: preApprovedChangedFiles,
  });
  const result = await validateCommitAndAdvance({
    task,
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    config: ctx.config,
    bus: ctx.bus,
    state,
    method,
    transitionType,
    commitSuffix,
    taskStartTime: ctx.taskStartTime,
    retryCount,
    implementerProfile: ctx.implementerProfile,
    acceptance,
    taskChangedFiles: preApprovedChangedFiles,
  });
  if (!result.completed) return { ...result, validationResults, acceptance };
  const checked = await runTaskChecksAfterAcceptance({ wctx: ctx, state: result.state, task });
  return { ...result, state: checked.state, validationResults, acceptance };
}
