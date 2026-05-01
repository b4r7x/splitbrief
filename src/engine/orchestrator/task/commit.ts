import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ValidationResult } from '../validation.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import { commitChanges, createTaggedStash, stageAll } from '../../../lib/git.js';
import { labelError } from '../../../utils/format-errors.js';
import { publishWarning, publishGitCommit, publishGitCheckpoint, publishTaskComplete } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { runPreHooks } from '../../hooks/run-pre-hook.js';

type ValidateCommitOptions = {
  task: Task;
  results: ValidationResult[];
  projectDir: string;
  sessionId: string;
  config: Config;
  state: WorkflowState;
  bus: EventBus;
  method: TaskCompletionMethod;
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS';
  commitSuffix?: string | undefined;
  taskStartTime?: number | undefined;
  retryCount?: number | undefined;
  implementerProfile?: string | undefined;
};

export async function validateCommitAndAdvance(opts: ValidateCommitOptions): Promise<{ state: WorkflowState; completed: boolean }> {
  const { task, results, projectDir, sessionId, config, bus, method, transitionType, commitSuffix, taskStartTime, state, retryCount, implementerProfile } = opts;
  if (!results.every((r) => r.passed)) {
    return { state, completed: false };
  }

  const strategy = config.workflow.git?.commitStrategy;
  if (strategy === 'per-task') {
    const suffix = commitSuffix ? ` (${commitSuffix})` : '';
    const commitMsg = `feat(diptych): ${task.id} - ${task.title}${suffix}`;

    if (config.hooks) {
      const preCommitPayload: import('../../events/types.js').EngineEvent = {
        type: 'git_commit', ts: Date.now(), phase: state.phase, taskId: task.id, message: commitMsg, file: task.file,
      };
      const pre = await runPreHooks(config.hooks, 'pre_commit', preCommitPayload, { projectDir, sessionId });
      if (!pre.allow) {
        publishWarning(bus, state.phase, `pre_commit blocked: ${pre.reason ?? 'hook denied'}`);
        const nextState = transitionAndSave(projectDir, sessionId, state, { type: transitionType });
        publishTaskComplete(bus, nextState.phase, {
          taskId: task.id, title: task.title,
          method, retries: retryCount ?? state.attempt,
          duration: taskStartTime ? Date.now() - taskStartTime : 0,
          ...(state.implementerTool !== undefined && { tool: state.implementerTool }),
          ...(state.implementerModel !== undefined && { model: state.implementerModel }),
          ...(implementerProfile !== undefined && { implementerProfile }),
        });
        return { state: nextState, completed: true };
      }
    }

    try {
      await stageAll(projectDir);
      await commitChanges(projectDir, commitMsg);
      publishGitCommit(bus, state.phase, task.id, commitMsg, task.file);
    } catch (err) {
      publishWarning(bus, state.phase, labelError('Failed to commit', err));
    }
  } else if (strategy === 'checkpoint') {
    try {
      const tag = await createTaggedStash(projectDir, `diptych checkpoint: ${task.id}`, `diptych/${task.id}`);
      if (tag) {
        publishGitCheckpoint(bus, state.phase, task.id, tag);
      }
    } catch (err) {
      publishWarning(bus, state.phase, labelError('Failed to create checkpoint', err));
    }
  }

  const nextState = transitionAndSave(projectDir, sessionId, state, { type: transitionType });
  publishTaskComplete(bus, nextState.phase, {
    taskId: task.id, title: task.title,
    method, retries: retryCount ?? state.attempt,
    duration: taskStartTime ? Date.now() - taskStartTime : 0,
    ...(state.implementerTool !== undefined && { tool: state.implementerTool }),
    ...(state.implementerModel !== undefined && { model: state.implementerModel }),
    ...(implementerProfile !== undefined && { implementerProfile }),
  });

  return { state: nextState, completed: true };
}
