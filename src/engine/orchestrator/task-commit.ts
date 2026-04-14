import type { Task, Config, WorkflowState, OrchestratorCallbacks, ValidationResult, TaskCompletionMethod } from '../../types.js';
import { commitChanges } from '../../utils/git.js';
import { createCheckpoint } from './git-ops.js';
import { labelError } from '../../utils/format.js';
import { emit, emitWarning, emitGitCommit, emitGitCheckpoint, emitTaskComplete } from './events.js';
import { allValidationsPassed, transitionAndSave } from './helpers.js';

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
  if (!allValidationsPassed(results)) {
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
