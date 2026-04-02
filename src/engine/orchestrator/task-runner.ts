import type { Task, Config, WorkflowState, OrchestratorCallbacks, ValidationResult } from '../../types.js';
import { transition } from '../../state.js';
import { saveState } from '../../state-persistence.js';
import { commitChanges } from '../../utils/git.js';
import { emit } from './events.js';
import { allValidationsPassed } from './helpers.js';

type ValidateCommitOptions = {
  task: Task;
  results: ValidationResult[];
  projectDir: string;
  config: Config;
  state: WorkflowState;
  callbacks: OrchestratorCallbacks;
  method: 'local' | 'local_with_hints' | 'escalated';
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

  if (config.workflow.commitPerTask) {
    const suffix = commitSuffix ? ` (${commitSuffix})` : '';
    const commitMsg = `feat(tiny-spec): ${task.id} - ${task.title}${suffix}`;
    try {
      await commitChanges(projectDir, commitMsg);
      callbacks.onEvent({ type: 'git-commit', ts: Date.now(), message: commitMsg });
    } catch {
      // commit failure is non-fatal
    }
  }

  const nextState = transition(state, { type: transitionType });
  saveState(projectDir, nextState);
  task.status = method === 'escalated' ? 'escalated' : 'done';
  const taskMethod = method === 'escalated' ? 'escalated' as const : 'local' as const;
  callbacks.onEvent({
    type: 'task-complete', ts: Date.now(), taskId: task.id, title: task.title,
    method: taskMethod, retries: state.attempt,
    duration: taskStartTime ? Date.now() - taskStartTime : 0,
  });
  emit(projectDir, nextState, 'task_completed', task.id, { method });

  return { state: nextState, completed: true };
}
