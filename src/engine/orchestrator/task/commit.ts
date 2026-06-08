import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ValidationResult } from '../validation-result.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { EventBus, EngineEvent } from '../../events/types.js';
import {
  commitChanges,
  createTaggedStash,
  stageAll,
  resetIndex,
  getCurrentChangedFiles,
} from '../../../lib/git.js';
import {
  publishWarning,
  publishWarningFromError,
  publishGitCommit,
  publishGitCheckpoint,
  publishTaskComplete,
} from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { runPreHooks } from '../../hooks/run-pre.js';

type GitOps = {
  stageAll: typeof stageAll;
  commitChanges: typeof commitChanges;
  createTaggedStash: typeof createTaggedStash;
  resetIndex: typeof resetIndex;
};

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
  gitOps?: Partial<GitOps> | undefined;
};

export async function validateCommitAndAdvance(
  opts: ValidateCommitOptions,
): Promise<{ state: WorkflowState; completed: boolean }> {
  const {
    task,
    results,
    projectDir,
    sessionId,
    config,
    bus,
    method,
    transitionType,
    commitSuffix,
    taskStartTime,
    state,
    retryCount,
    implementerProfile,
  } = opts;
  const gitOps: GitOps = {
    stageAll,
    commitChanges,
    createTaggedStash,
    resetIndex,
    ...opts.gitOps,
  };
  if (!results.every((r) => r.passed)) {
    return { state, completed: false };
  }

  const emitTaskComplete = (nextState: WorkflowState) => {
    publishTaskComplete(
      { bus: bus, phase: nextState.phase },
      {
        taskId: task.id,
        title: task.title,
        method,
        retries: retryCount ?? state.attempt,
        duration: taskStartTime ? Date.now() - taskStartTime : 0,
        ...(state.implementerTool !== undefined && { tool: state.implementerTool }),
        ...(state.implementerModel !== undefined && { model: state.implementerModel }),
        ...(implementerProfile !== undefined && { implementerProfile }),
      },
    );
  };

  const strategy = config.workflow.git?.commitStrategy;
  if (strategy === 'per-task') {
    const suffix = commitSuffix ? ` (${commitSuffix})` : '';
    const commitMsg = `feat(diptych): ${task.id} - ${task.title}${suffix}`;

    try {
      // Stage before the pre_commit hook so a hook that inspects the git index
      // (e.g. `git diff --cached`) sees every file this commit will include.
      await gitOps.stageAll(projectDir);

      if (config.hooks) {
        let files: string[] = [task.file];
        try {
          files = await getCurrentChangedFiles(projectDir);
        } catch {
          // keep task.file as the fallback set
        }
        const preCommitPayload: EngineEvent = {
          type: 'git_commit',
          ts: Date.now(),
          phase: state.phase,
          taskId: task.id,
          message: commitMsg,
          file: task.file,
        };
        const pre = await runPreHooks(config.hooks, 'pre_commit', preCommitPayload, {
          projectDir,
          sessionId,
          files,
        });
        if (!pre.allow) {
          try {
            await gitOps.resetIndex(projectDir);
          } catch {
            // best-effort unstage
          }
          publishWarning(
            { bus: bus, phase: state.phase },
            `pre_commit blocked: ${pre.reason ?? 'hook denied'}`,
          );
          const nextState = transitionAndSave({ projectDir, sessionId }, state, {
            type: transitionType,
          });
          emitTaskComplete(nextState);
          return { state: nextState, completed: true };
        }
      }

      await gitOps.commitChanges(projectDir, commitMsg);
      publishGitCommit({ bus: bus, phase: state.phase }, task.id, commitMsg, task.file);
    } catch (err) {
      try {
        await gitOps.resetIndex(projectDir);
      } catch {
        // best-effort unstage
      }
      publishWarningFromError({ bus: bus, phase: state.phase }, 'Failed to commit', err);
    }
  } else if (strategy === 'checkpoint') {
    try {
      const tag = await gitOps.createTaggedStash(
        projectDir,
        `diptych checkpoint: ${task.id}`,
        `diptych/${task.id}`,
      );
      if (tag) {
        publishGitCheckpoint({ bus: bus, phase: state.phase }, task.id, tag);
      }
    } catch (err) {
      publishWarningFromError({ bus: bus, phase: state.phase }, 'Failed to create checkpoint', err);
    }
  }

  const nextState = transitionAndSave({ projectDir, sessionId }, state, { type: transitionType });
  emitTaskComplete(nextState);

  return { state: nextState, completed: true };
}
