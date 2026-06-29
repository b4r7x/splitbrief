import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import { validateCommitAndAdvance } from '../task/commit.js';
import type { EscalationContext } from './types.js';

export type ValidateAndCommitOptions = {
  ctx: EscalationContext;
  task: Task;
  state: WorkflowState;
  method: TaskCompletionMethod;
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS';
  retryCount: number;
  commitSuffix?: string | undefined;
  preApprovedChangedFiles: string[];
};

export async function validateAndCommit(opts: ValidateAndCommitOptions) {
  const { ctx, task, state, method, transitionType, retryCount, commitSuffix } = opts;
  const { preApprovedChangedFiles } = opts;
  if (ctx.signal?.aborted) {
    return { state, completed: false, validationResults: [], blockedReason: 'aborted' };
  }

  const validationResults = await ctx.validator.runValidation({
    task,
    projectDir: ctx.projectDir,
    config: ctx.config,
    bus: ctx.bus,
    phase: state.phase,
    discoveredValidation: state.discoveredValidation,
    signal: ctx.signal,
  });
  if (ctx.signal?.aborted) {
    return { state, completed: false, validationResults, blockedReason: 'aborted' };
  }
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
    results: validationResults,
    taskChangedFiles: preApprovedChangedFiles,
  });
  return { ...result, validationResults };
}
