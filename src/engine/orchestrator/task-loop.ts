import type { Task, TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks } from './types.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { EventBus } from '../events/types.js';
import { hasExternalChanges } from '../../lib/git.js';
import { labelError } from '../../utils/format-errors.js';
import { getFailedTaskIds, getSkippedTaskIds, getEscalatedTaskIds } from '../../core/state/selectors.js';

import type { WorkflowContext } from './types.js';
import { publishEvent, publishWarning, publishTaskSkipped } from './events.js';
import { runSingleTask } from './task-step.js';
import { emitTaskTokens } from './tokens.js';
import { transitionAndSave } from './state-ops.js';
import { enforceBudget } from './budget.js';
import { getRunnerDisplayName } from '../../core/config/accessors/runner-config.js';

function hasDependencyFailed(task: Task, failedTasks: TaskId[], skippedTasks: TaskId[]): boolean {
  const blocked = new Set<string>([...failedTasks, ...skippedTasks]);
  return task.dependsOn.some((dep) => blocked.has(dep));
}

async function checkExternalChanges(
  projectDir: string, sessionId: string, callbacks: OrchestratorCallbacks, bus: EventBus, state: WorkflowState,
): Promise<WorkflowState | null> {
  try {
    const externalChanges = await hasExternalChanges(projectDir);
    if (externalChanges) {
      const proceed = await callbacks.onExternalChanges();
      if (!proceed) {
        publishEvent(bus, { type: 'paused_external_changes', ts: Date.now(), phase: state.phase });
        const cancelled = transitionAndSave(projectDir, sessionId, state, { type: 'CANCEL' });
        return cancelled;
      }
    }
  } catch (err) {
    publishWarning(bus, state.phase, labelError('Failed to check external changes', err));
  }
  return null;
}

type HandleSkippedTaskOptions = {
  task: Task;
  state: WorkflowState;
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  taskBreakdowns: TaskTokenUsage[];
};

function handleSkippedTask(opts: HandleSkippedTaskOptions): WorkflowState {
  const { task, projectDir, sessionId, bus, taskBreakdowns } = opts;
  const blockedBy = new Set<string>([
    ...getFailedTaskIds(opts.state),
    ...getSkippedTaskIds(opts.state),
  ]);
  const skipReason = `dependency failed: ${task.dependsOn.filter((d) => blockedBy.has(d)).join(', ')}`;
  const state = transitionAndSave(projectDir, sessionId, opts.state, { type: 'SKIP_TASK', taskId: task.id });
  publishTaskSkipped(bus, state.phase, { taskId: task.id, title: task.title, reason: skipReason });
  const usage: TaskTokenUsage = { taskId: task.id, taskTitle: task.title, method: 'skipped', implementerTokens: 0, escalationTokens: 0, retryCount: 0 };
  taskBreakdowns.push(usage);
  emitTaskTokens(bus, state, task.id, usage);
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
  const { projectDir, sessionId, config, callbacks } = wctx;
  let state = opts.initialState;
  const totalTasks = state.tasks.length;
  const taskBreakdowns: TaskTokenUsage[] = [];
  let budgetWarningEmitted = false;

  for (let i = state.currentTaskIndex; i < totalTasks; i++) {
    if (wctx.signal?.aborted) return { state, taskBreakdowns };

    const task = state.tasks[i];
    if (!task) continue;

    const cancelledState = await checkExternalChanges(projectDir, sessionId, callbacks, wctx.bus, state);
    if (cancelledState) return { state: cancelledState, taskBreakdowns };

    if (hasDependencyFailed(task, getFailedTaskIds(state), getSkippedTaskIds(state))) {
      state = handleSkippedTask({ task, state, projectDir, sessionId, bus: wctx.bus, taskBreakdowns });
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
        bus: wctx.bus,
        warningEmitted: budgetWarningEmitted,
      });
      budgetWarningEmitted = budgetResult.warningEmitted;
      if (budgetResult.stop) {
        setCurrentTask(undefined);
        const cancelled = transitionAndSave(projectDir, sessionId, state, { type: 'CANCEL' });
        return { state: cancelled, taskBreakdowns };
      }
    }
  }
  setCurrentTask(undefined);

  return { state, taskBreakdowns };
}
