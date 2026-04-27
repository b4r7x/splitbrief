import type { Task, TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks } from './types.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { EventBus } from '../events/types.js';
import type { Phase } from '../../core/schemas/enums.js';
import { hasExternalChanges } from '../../lib/git.js';
import { labelError } from '../../utils/format-errors.js';
import { getFailedTaskIds, getSkippedTaskIds, getEscalatedTaskIds } from '../../core/state/selectors.js';

import type { WorkflowContext } from './types.js';
import { publishEvent, publishWarning, publishTaskSkipped } from './events.js';
import { runSingleTask } from './task-step.js';
import { emitTaskTokens } from './tokens.js';
import { transitionAndSave } from './state-ops.js';
import { enforceBudget } from './budget.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../core/config/accessors/runner-config.js';
import { DEFAULT_WORKFLOW_MODE } from '../../core/schemas/config.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import {
  createEvidenceLedger,
  readEvidenceLedger,
  recordSkippedTaskEvidence,
  writeEvidenceLedger,
} from './evidence.js';
import { createSnapshot } from '../snapshots/store.js';
import { recordRunSnapshot } from '../snapshots/run.js';
import { hashTaskBrief } from '../../core/brief-hash.js';

async function maybeAutoSnapshot(opts: {
  projectDir: string;
  sessionId: string;
  config: WorkflowContext['config'];
  bus: EventBus;
  phase: Phase;
  enabled: boolean;
  taskIndex?: number;
  label: string;
  recordInRunLedger?: boolean;
}): Promise<void> {
  if (!opts.enabled) return;
  try {
    const result = await createSnapshot({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      phase: 'manual',
      name: opts.label,
      ...(opts.taskIndex !== undefined && { taskIndex: opts.taskIndex }),
      bus: opts.bus,
      eventPhase: opts.phase,
    });
    if (opts.recordInRunLedger) {
      await recordRunSnapshot(opts.projectDir, opts.sessionId, result.manifest);
    }
  } catch (err) {
    publishWarning(opts.bus, opts.phase, labelError(`auto-snapshot (${opts.label}) failed`, err));
  }
}

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
  config: WorkflowContext['config'];
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
  try {
    const briefHash = hashTaskBrief(state.tasks);
    const ledger = readEvidenceLedger(projectDir, sessionId) ?? createEvidenceLedger({
      sessionId,
      feature: state.feature,
      mode: opts.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      tasks: state.tasks,
      briefHash,
    });
    const updated = recordSkippedTaskEvidence({ ledger, task, reason: skipReason, briefHash });
    writeEvidenceLedger(projectDir, sessionId, updated);
  } catch (err) {
    publishWarning(bus, state.phase, labelError('failed to persist evidence ledger', err));
  }
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
  let budgetPauseEmitted = false;

  // Budget pause fires only at task boundaries. A long-running planner call
  // will not be interrupted mid-stream; the pause applies to the next task start.
  for (let i = state.currentTaskIndex; i < totalTasks; i++) {
    if (wctx.signal?.aborted) return { state, taskBreakdowns };

    const task = state.tasks[i];
    if (!task) continue;

    const cancelledState = await checkExternalChanges(projectDir, sessionId, callbacks, wctx.bus, state);
    if (cancelledState) return { state: cancelledState, taskBreakdowns };

    if (hasDependencyFailed(task, getFailedTaskIds(state), getSkippedTaskIds(state))) {
      state = handleSkippedTask({ task, state, projectDir, sessionId, config, bus: wctx.bus, taskBreakdowns });
      continue;
    }

    await maybeAutoSnapshot({
      projectDir,
      sessionId,
      config,
      bus: wctx.bus,
      phase: state.phase,
      enabled: config.snapshots?.auto?.preTask === true,
      taskIndex: i,
      label: `pre-task-${i}`,
    });

    state = await runSingleTask({ wctx, task, index: i, totalTasks, state, taskBreakdowns, setTrackedState, setCurrentTask });

    const completedTask = state.tasks[i];
    const succeeded = completedTask?.status === 'done';
    if (state.currentTaskIndex <= i) {
      setCurrentTask(undefined);
      return { state, taskBreakdowns };
    }

    await maybeAutoSnapshot({
      projectDir,
      sessionId,
      config,
      bus: wctx.bus,
      phase: state.phase,
      enabled: succeeded && config.snapshots?.auto?.postTask === true,
      taskIndex: i,
      label: `post-task-${i}`,
      recordInRunLedger: true,
    });

    if (config.workflow.maxBudget !== undefined) {
      const plannerModel = state.plannerModel ?? getRunnerModelName(config.planner);
      const implementerModel = state.implementerModel ?? getRunnerModelName(config.implementer);
      const budgetResult = await enforceBudget({
        tokenUsage: state.tokenUsage,
        maxBudget: config.workflow.maxBudget,
        totalTasks,
        escalatedCount: getEscalatedTaskIds(state).length,
        plannerTool: state.plannerTool ?? getRunnerDisplayName(config.planner),
        implementerTool: getRunnerDisplayName(config.implementer),
        ...(plannerModel !== undefined && { plannerModel }),
        ...(implementerModel !== undefined && { implementerModel }),
        pricingCache: modelCacheStore,
        callbacks,
        bus: wctx.bus,
        warningEmitted: budgetWarningEmitted,
        pauseEmitted: budgetPauseEmitted,
        pauseThreshold: config.workflow.budgetPauseThreshold,
      });
      budgetWarningEmitted = budgetResult.warningEmitted;
      budgetPauseEmitted = budgetResult.pauseEmitted;
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
