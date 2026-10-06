import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import { publishWarning, publishTaskComplete } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';

type ValidateCommitOptions = {
  task: Task;
  acceptance: ValidationAcceptance;
  projectDir: string;
  sessionId: string;
  config: Config;
  state: WorkflowState;
  bus: EventBus;
  method: TaskCompletionMethod;
  transitionType: 'VALIDATION_PASS';
  commitSuffix?: string | undefined;
  taskStartTime?: number | undefined;
  retryCount?: number | undefined;
  implementerProfile?: string | undefined;
  taskChangedFiles?: string[] | undefined;
  /** What a `file-bundle-v1` response put on disk; absent for every other grammar. */
  applyResult?: BundleApplyResult | undefined;
};

/**
 * SCOPE_RULE's suggested set: this brief's declared set plus the files of every
 * brief already done. What a task wrote outside that set is what the review
 * names as touched, not suggested.
 */
export function touchedNotSuggestedFiles(opts: {
  task: Task;
  tasks: readonly Task[];
  taskChangedFiles: readonly string[];
}): string[] {
  const suggested = [
    ...taskDeclaredPatterns(opts.task),
    ...opts.tasks.filter((t) => isTaskCompleted(t.status)).flatMap((t) => t.suggestedFiles),
  ];
  return opts.taskChangedFiles.filter((file) => !isInDeclaredSet(file, suggested));
}

export async function validateCommitAndAdvance(
  opts: ValidateCommitOptions,
): Promise<{ state: WorkflowState; completed: boolean }> {
  const {
    task,
    acceptance,
    projectDir,
    sessionId,
    bus,
    method,
    transitionType,
    taskStartTime,
    state,
    retryCount,
    implementerProfile,
  } = opts;
  // An application that did not finish is never this brief's completion, and no
  // validation verdict over the files that did land can make it one.
  if (opts.applyResult !== undefined && opts.applyResult.status !== 'applied') {
    return { state, completed: false };
  }
  if (!acceptance.accepted) {
    return { state, completed: false };
  }
  if (acceptance.exemptStages.length > 0) {
    publishWarning({
      bus: bus,
      phase: state.phase,
      taskId: task.id,
      message: `Task ${task.id} accepted over pre-existing failures in ${acceptance.exemptStages.join(', ')} (already failing before this run; not attributed to this task).`,
      safety: {
        category: 'workflow',
        code: 'validation_baseline_exempt',
      },
    });
  }

  const nextState = transitionAndSave({ projectDir, sessionId }, state, {
    type: transitionType,
  });
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
  const touchedNotSuggested = touchedNotSuggestedFiles({
    task,
    tasks: state.tasks,
    taskChangedFiles: opts.taskChangedFiles ?? [],
  });
  if (touchedNotSuggested.length > 0) {
    bus.publish({
      type: 'task_touched_not_suggested',
      ts: Date.now(),
      phase: nextState.phase,
      taskId: task.id,
      files: touchedNotSuggested,
    });
  }

  return { state: nextState, completed: true };
}
