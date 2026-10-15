import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import { validateCommitAndAdvance } from '../task/commit.js';
import { runBriefGate } from '../task/brief-gate.js';
import type { EscalationContext } from './types.js';

export type ValidateAndCommitOptions = {
  ctx: EscalationContext;
  task: Task;
  state: WorkflowState;
  method: TaskCompletionMethod;
  transitionType: 'VALIDATION_PASS';
  retryCount: number;
  commitSuffix?: string | undefined;
  preApprovedChangedFiles: string[];
  attemptSnapshot: ChangedFilesSnapshot;
};

export async function validateAndCommit(opts: ValidateAndCommitOptions) {
  const { ctx, task, method, transitionType, retryCount, commitSuffix } = opts;
  const { preApprovedChangedFiles } = opts;
  let state = opts.state;
  if (ctx.signal?.aborted) {
    return {
      state,
      completed: false,
      blockedReason: 'aborted',
    };
  }

  const gated = await runBriefGate({
    wctx: ctx,
    task,
    state,
    changedFiles: preApprovedChangedFiles,
    taskStartSnapshot: ctx.taskStartSnapshot,
    attemptSnapshot: opts.attemptSnapshot,
  });
  state = gated.state;
  const { acceptance } = gated;
  if (gated.stop !== undefined) return { state, completed: false, blockedReason: gated.stop };
  if (gated.correction) return { state, completed: false, answer: gated.error };
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
    retryCount,
    implementerProfile: ctx.implementerProfile,
    acceptance,
    taskChangedFiles: preApprovedChangedFiles,
  });
  return {
    ...result,
    error: gated.error,
    diagnosis: gated.diagnosis,
  };
}
