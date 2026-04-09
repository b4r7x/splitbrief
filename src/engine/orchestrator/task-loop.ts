import type { Task, WorkflowState, OrchestratorCallbacks, TaskTokenUsage } from '../../types.js';
import { saveState } from '../../core/state/persistence.js';
import { hasExternalChanges } from '../../utils/git.js';

import type { WorkflowContext } from './run.js';
import { emit } from './events.js';
import { runSingleTask, emitTaskTokens } from './task-step.js';
import { transitionAndSave } from './helpers.js';

export function hasDependencyFailed(task: Task, failedTasks: string[], skippedTasks: string[]): boolean {
  const blocked = new Set([...failedTasks, ...skippedTasks]);
  return task.dependsOn.some((dep) => blocked.has(dep));
}

async function checkExternalChanges(
  projectDir: string, callbacks: OrchestratorCallbacks, state: WorkflowState, taskId: string,
): Promise<WorkflowState | null> {
  try {
    const externalChanges = await hasExternalChanges(projectDir);
    if (externalChanges) {
      const proceed = await callbacks.onExternalChanges();
      if (!proceed) {
        emit(projectDir, state, 'paused_external_changes', taskId);
        const cancelled = transitionAndSave(projectDir, state, { type: 'CANCEL' });
        return cancelled;
      }
    }
  } catch (err) {
    callbacks.onEvent({ type: 'warning', ts: Date.now(), message: `Failed to check external changes: ${err}` });
  }
  return null;
}

type HandleSkippedTaskOptions = {
  task: Task;
  state: WorkflowState;
  projectDir: string;
  callbacks: OrchestratorCallbacks;
  taskBreakdowns: TaskTokenUsage[];
  index: number;
};

function handleSkippedTask(opts: HandleSkippedTaskOptions): WorkflowState {
  const { task, projectDir, callbacks, taskBreakdowns, index } = opts;
  task.status = 'skipped';
  const state = {
    ...opts.state,
    skippedTasks: [...opts.state.skippedTasks, task.id],
    currentTaskIndex: index + 1,
  };
  const skipReason = `dependency failed: ${task.dependsOn.filter((d) => state.failedTasks.includes(d) || state.skippedTasks.includes(d)).join(', ')}`;
  callbacks.onEvent({ type: 'task-skipped', ts: Date.now(), taskId: task.id, title: task.title, reason: skipReason });
  emit(projectDir, state, 'task_skipped', task.id);
  const usage: TaskTokenUsage = { taskId: task.id, taskTitle: task.title, method: 'skipped', implementerTokens: 0, escalationTokens: 0, retryCount: 0 };
  taskBreakdowns.push(usage);
  emitTaskTokens(projectDir, state, task.id, usage);
  saveState(projectDir, state);
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
  const { projectDir, callbacks } = wctx;
  let state = opts.initialState;
  const totalTasks = state.tasks.length;
  const taskBreakdowns: TaskTokenUsage[] = [];

  for (let i = state.currentTaskIndex; i < totalTasks; i++) {
    if (wctx.signal?.aborted) return { state, taskBreakdowns };

    const task = state.tasks[i];
    if (!task) continue;

    const cancelledState = await checkExternalChanges(projectDir, callbacks, state, task.id);
    if (cancelledState) return { state: cancelledState, taskBreakdowns };

    if (hasDependencyFailed(task, state.failedTasks, state.skippedTasks)) {
      state = handleSkippedTask({ task, state, projectDir, callbacks, taskBreakdowns, index: i });
      continue;
    }

    state = await runSingleTask({ wctx, task, index: i, totalTasks, state, taskBreakdowns, setTrackedState, setCurrentTask });
  }
  setCurrentTask(undefined);

  return { state, taskBreakdowns };
}
