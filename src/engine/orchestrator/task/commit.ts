import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Config } from '../../../core/schemas/config.js';
import type { ValidationAcceptance } from '../validation/acceptance.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { EventBus } from '../../events/types.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import { classifyTaskCompletionMethod } from '../../../core/task-completion.js';
import { publishWarning, publishTaskComplete } from '../events.js';
import { transitionAndSave } from '../state-ops.js';

type ValidateCommitOptions = {
  task: Task;
  acceptance: ValidationAcceptance;
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
  /** What a `file-bundle-v1` response put on disk; absent for every other grammar. */
  applyResult?: BundleApplyResult | undefined;
};

function transitionTypeForCompletionMethod(
  method: TaskCompletionMethod,
  fallback: ValidateCommitOptions['transitionType'],
): ValidateCommitOptions['transitionType'] {
  const completionClass = classifyTaskCompletionMethod(method);
  if (completionClass !== 'escalated') return fallback;
  return method === 'escalated-full' ? 'FULL_SUCCESS' : 'HINT_SUCCESS';
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
  const completionTransitionType = transitionTypeForCompletionMethod(method, transitionType);
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
    type: completionTransitionType,
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

  return { state: nextState, completed: true };
}
