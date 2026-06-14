import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ValidationResult } from '../validation-result.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { EventBus, EngineEvent } from '../../events/types.js';
import {
  commitChanges,
  createTaggedStash,
  stageFiles,
  getStagedFiles,
  getInProgressGitOp,
  resetIndexPreservingStaged,
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

export const RUN_COMMIT_MESSAGE_PREFIX = 'feat(diptych):';

type GitOps = {
  stageFiles: typeof stageFiles;
  getStagedFiles: typeof getStagedFiles;
  getInProgressGitOp: typeof getInProgressGitOp;
  commitChanges: typeof commitChanges;
  createTaggedStash: typeof createTaggedStash;
  resetIndexPreservingStaged: typeof resetIndexPreservingStaged;
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
  taskChangedFiles?: string[] | undefined;
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
    stageFiles,
    getStagedFiles,
    getInProgressGitOp,
    commitChanges,
    createTaggedStash,
    resetIndexPreservingStaged,
    ...opts.gitOps,
  };
  const taskChangedFiles = opts.taskChangedFiles ?? [task.file];
  const usingFallbackFiles = opts.taskChangedFiles === undefined;
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
    const inProgressOp = await gitOps.getInProgressGitOp(projectDir);
    if (inProgressOp) {
      publishWarning(
        { bus: bus, phase: state.phase },
        `Skipped per-task commit: a git ${inProgressOp} is in progress. Finish or abort it first.`,
      );
      const nextState = transitionAndSave({ projectDir, sessionId }, state, {
        type: transitionType,
      });
      emitTaskComplete(nextState);
      return { state: nextState, completed: true };
    }

    if (usingFallbackFiles) {
      publishWarning(
        { bus: bus, phase: state.phase },
        `No attributed file set for ${task.id}; staging and secret scan cover only ${task.file}.`,
      );
    }

    const suffix = commitSuffix ? ` (${commitSuffix})` : '';
    const commitMsg = `${RUN_COMMIT_MESSAGE_PREFIX} ${task.id} - ${task.title}${suffix}`;

    const stagedBefore = await gitOps.getStagedFiles(projectDir);
    try {
      // Stage only the attributed/approved set before the pre_commit hook so a
      // hook that inspects the git index (e.g. `git diff --cached`) sees every
      // file this commit will include — and the user's unrelated dirty and
      // untracked files stay out of authored history.
      await gitOps.stageFiles(projectDir, taskChangedFiles);

      if (config.hooks) {
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
          files: taskChangedFiles,
        });
        if (!pre.allow) {
          try {
            await gitOps.resetIndexPreservingStaged(projectDir, stagedBefore);
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
        await gitOps.resetIndexPreservingStaged(projectDir, stagedBefore);
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
        `diptych/${sessionId}/${task.id}`,
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
