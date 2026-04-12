import type { Task, TaskId, WorkflowState, OrchestratorCallbacks, TaskTokenUsage } from '../../types.js';
import { hasExternalChanges } from '../../utils/git.js';
import { toErrorMessage } from '../../utils/format.js';
import { getFailedTaskIds, getSkippedTaskIds, getEscalatedTaskIds } from '../../core/state/selectors.js';

import type { WorkflowContext } from './run.js';
import { emit, emitWarning, emitTaskSkipped } from './events.js';
import { runSingleTask } from './task-step.js';
import { emitTaskTokens } from './tokens.js';
import { transitionAndSave } from './helpers.js';
import { enforceBudget } from './budget.js';
import { getRunnerDisplayName } from '../../core/config/runner-config.js';

export function hasDependencyFailed(task: Task, failedTasks: TaskId[], skippedTasks: TaskId[]): boolean {
  const blocked = new Set<string>([...failedTasks, ...skippedTasks]);
  return task.dependsOn.some((dep) => blocked.has(dep));
}

async function checkExternalChanges(
  projectDir: string, callbacks: OrchestratorCallbacks, state: WorkflowState, taskId: TaskId,
): Promise<WorkflowState | null> {
  try {
    const externalChanges = await hasExternalChanges(projectDir);
    if (externalChanges) {
      const proceed = await callbacks.onExternalChanges();
      if (!proceed) {
        emit(projectDir, state, 'paused_external_changes', taskId, {});
        const cancelled = transitionAndSave(projectDir, state, { type: 'CANCEL' });
        return cancelled;
      }
    }
  } catch (err) {
    emitWarning(callbacks, `Failed to check external changes: ${toErrorMessage(err)}`);
  }
  return null;
}

type HandleSkippedTaskOptions = {
  task: Task;
  state: WorkflowState;
  projectDir: string;
  callbacks: OrchestratorCallbacks;
  taskBreakdowns: TaskTokenUsage[];
};

function handleSkippedTask(opts: HandleSkippedTaskOptions): WorkflowState {
  const { task, projectDir, callbacks, taskBreakdowns } = opts;
  const blockedBy = new Set<string>([
    ...getFailedTaskIds(opts.state),
    ...getSkippedTaskIds(opts.state),
  ]);
  const skipReason = `dependency failed: ${task.dependsOn.filter((d) => blockedBy.has(d)).join(', ')}`;
  const state = transitionAndSave(projectDir, opts.state, { type: 'SKIP_TASK', taskId: task.id });
  emitTaskSkipped(callbacks, { taskId: task.id, title: task.title, reason: skipReason });
  emit(projectDir, state, 'task_skipped', task.id, {});
  const usage: TaskTokenUsage = { taskId: task.id, taskTitle: task.title, method: 'skipped', implementerTokens: 0, escalationTokens: 0, retryCount: 0 };
  taskBreakdowns.push(usage);
  emitTaskTokens(projectDir, state, task.id, usage);
  return state;
}

type RunTaskLoopOptions = {
  wctx: WorkflowContext;
  initialState: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'action'> | undefined) => void;
};

export async function runTaskLoop(opts: RunTaskLoopOptions): Promise<{ state: WorkflowState; taskBreakdowns: TaskTokenUsage[] }> {
  const { wctx, setTrackedState, setCurrentTask } = opts;
  const { projectDir, config, callbacks } = wctx;
  let state = opts.initialState;
  const totalTasks = state.tasks.length;
  const taskBreakdowns: TaskTokenUsage[] = [];
  let budgetWarningEmitted = false;

  for (let i = state.currentTaskIndex; i < totalTasks; i++) {
    if (wctx.signal?.aborted) return { state, taskBreakdowns };

    const task = state.tasks[i];
    if (!task) continue;

    const cancelledState = await checkExternalChanges(projectDir, callbacks, state, task.id);
    if (cancelledState) return { state: cancelledState, taskBreakdowns };

    if (hasDependencyFailed(task, getFailedTaskIds(state), getSkippedTaskIds(state))) {
      state = handleSkippedTask({ task, state, projectDir, callbacks, taskBreakdowns });
      continue;
    }

    state = await runSingleTask({ wctx, task, index: i, totalTasks, state, taskBreakdowns, setTrackedState, setCurrentTask });

    if (config.workflow.maxBudget !== undefined) {
      const budgetResult = await enforceBudget({
        tokenUsage: state.tokenUsage,
        maxBudget: config.workflow.maxBudget,
        totalTasks,
        escalatedCount: getEscalatedTaskIds(state).length,
        plannerTool: state.plannerTool ?? getRunnerDisplayName(config.planner),
        implementerTool: getRunnerDisplayName(config.implementer),
        callbacks,
        warningEmitted: budgetWarningEmitted,
      });
      budgetWarningEmitted = budgetResult.warningEmitted;
      if (budgetResult.stop) {
        setCurrentTask(undefined);
        const cancelled = transitionAndSave(projectDir, state, { type: 'CANCEL' });
        return { state: cancelled, taskBreakdowns };
      }
    }
  }
  setCurrentTask(undefined);

  return { state, taskBreakdowns };
}
