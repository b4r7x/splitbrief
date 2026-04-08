import type { Task, Config, WorkflowState, OrchestratorCallbacks, ValidationResult, TaskCompletionMethod } from '../../types.js';
import { commitChanges, createCheckpoint } from '../../utils/git.js';
import { emit } from './events.js';
import { allValidationsPassed, transitionAndSave } from './helpers.js';

type ValidateCommitOptions = {
  task: Task;
  results: ValidationResult[];
  projectDir: string;
  config: Config;
  state: WorkflowState;
  callbacks: OrchestratorCallbacks;
  method: TaskCompletionMethod;
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS';
  commitSuffix?: string;
  taskStartTime?: number;
};

export async function validateCommitAndAdvance(opts: ValidateCommitOptions): Promise<{ state: WorkflowState; completed: boolean }> {
  const { task, results, projectDir, config, callbacks, method, transitionType, commitSuffix, taskStartTime } = opts;
  let { state } = opts;
  if (!allValidationsPassed(results)) {
    return { state, completed: false };
  }

  const strategy = config.workflow.commitStrategy;
  if (strategy === 'per-task') {
    const suffix = commitSuffix ? ` (${commitSuffix})` : '';
    const commitMsg = `feat(tiny-spec): ${task.id} - ${task.title}${suffix}`;
    try {
      await commitChanges(projectDir, commitMsg);
      callbacks.onEvent({ type: 'git-commit', ts: Date.now(), message: commitMsg });
    } catch (err) {
      callbacks.onEvent({ type: 'warning', ts: Date.now(), message: `Failed to commit: ${err}` });
    }
  } else if (strategy === 'checkpoint') {
    const label = `${task.id}`;
    try {
      const tag = await createCheckpoint(projectDir, label);
      if (tag) {
        callbacks.onEvent({ type: 'git-checkpoint', ts: Date.now(), tag, taskId: task.id });
      }
    } catch (err) {
      callbacks.onEvent({ type: 'warning', ts: Date.now(), message: `Failed to create checkpoint: ${err}` });
    }
  }

  const nextState = transitionAndSave(projectDir, state, { type: transitionType });
  task.status = method === 'escalated-full' ? 'escalated' : 'done';
  callbacks.onEvent({
    type: 'task-complete', ts: Date.now(), taskId: task.id, title: task.title,
    method, retries: state.attempt,
    duration: taskStartTime ? Date.now() - taskStartTime : 0,
  });
  emit(projectDir, nextState, 'task_completed', task.id, { method });

  return { state: nextState, completed: true };
}
