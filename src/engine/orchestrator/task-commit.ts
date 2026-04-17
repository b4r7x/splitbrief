import type { Task, WorkflowState } from '../../core/types/state-actions.js';
import type { Config } from '../../core/types/config-options.js';
import type { OrchestratorCallbacks } from './types.js';
import type { ValidationResult, TaskCompletionMethod } from '../../core/types/summary.js';
import { commitChanges } from '../../lib/git.js';
import { createCheckpoint } from './git.js';
import { labelError } from '../../utils/format-errors.js';
import { emit, emitWarning, emitGitCommit, emitGitCheckpoint, emitTaskComplete } from './events.js';
import { transitionAndSave } from './state-ops.js';

type ValidateCommitOptions = {
  task: Task;
  results: ValidationResult[];
  projectDir: string;
  sessionId: string;
  config: Config;
  state: WorkflowState;
  callbacks: OrchestratorCallbacks;
  method: TaskCompletionMethod;
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS';
  commitSuffix?: string | undefined;
  taskStartTime?: number | undefined;
  retryCount?: number | undefined;
};

export async function validateCommitAndAdvance(opts: ValidateCommitOptions): Promise<{ state: WorkflowState; completed: boolean }> {
  const { task, results, projectDir, sessionId, config, callbacks, method, transitionType, commitSuffix, taskStartTime, state, retryCount } = opts;
  if (!results.every((r) => r.passed)) {
    return { state, completed: false };
  }

  const strategy = config.workflow.commitStrategy;
  if (strategy === 'per-task') {
    const suffix = commitSuffix ? ` (${commitSuffix})` : '';
    const commitMsg = `feat(diptych): ${task.id} - ${task.title}${suffix}`;
    try {
      await commitChanges(projectDir, commitMsg);
      emitGitCommit(callbacks, commitMsg);
    } catch (err) {
      emitWarning(callbacks, labelError('Failed to commit', err));
    }
  } else if (strategy === 'checkpoint') {
    try {
      const tag = await createCheckpoint(projectDir, task.id);
      if (tag) {
        emitGitCheckpoint(callbacks, tag, task.id);
      }
    } catch (err) {
      emitWarning(callbacks, labelError('Failed to create checkpoint', err));
    }
  }

  const nextState = transitionAndSave(projectDir, sessionId, state, { type: transitionType });
  emitTaskComplete(callbacks, {
    taskId: task.id, title: task.title,
    method, retries: retryCount ?? state.attempt,
    duration: taskStartTime ? Date.now() - taskStartTime : 0,
    ...(state.implementerTool !== undefined && { tool: state.implementerTool }),
    ...(state.implementerModel !== undefined && { model: state.implementerModel }),
  });
  emit(projectDir, sessionId, nextState, 'task_completed', task.id, { method });

  return { state: nextState, completed: true };
}
