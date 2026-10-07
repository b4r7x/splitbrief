import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import { validateCommitAndAdvance } from '../task/commit.js';
import { runBriefGate } from '../task/brief-gate.js';
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
  const { ctx, task, method, transitionType, retryCount, commitSuffix } = opts;
  const { preApprovedChangedFiles } = opts;
  let state = opts.state;
  if (ctx.signal?.aborted) {
    return {
      state,
      completed: false,
      validationResults: [],
      blockedReason: 'aborted',
      acceptance: NOT_ACCEPTED_ACCEPTANCE,
    };
  }

  const gated = await runBriefGate({
    wctx: ctx,
    task,
    state,
    changedFiles: preApprovedChangedFiles,
    taskStartSnapshot: ctx.taskStartSnapshot,
  });
  state = gated.state;
  const { validationResults, acceptance } = gated;
  if (gated.stop !== undefined)
    return { state, completed: false, validationResults, acceptance, blockedReason: gated.stop };
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
  return {
    ...result,
    validationResults,
    acceptance,
    error: gated.error,
    diagnosis: gated.diagnosis,
  };
}
