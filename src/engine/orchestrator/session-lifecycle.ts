import type { Config } from '../../core/schemas/config.js';
import type { Session } from '../../core/schemas/session.js';
import type { Summary } from '../../core/schemas/summary.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { EventBus } from '../events/types.js';
import { CURRENT_STATE_VERSION } from '../../core/state/machine.js';
import { clearActive } from '../../core/sessions/lifecycle.js';
import { saveSummary } from '../../core/sessions/io.js';
import { isResumable } from '../../core/phases.js';
import { saveState } from '../../core/state/persistence.js';
import { updateStats } from '../../core/stats/persistence.js';
import { warnError } from '../../lib/warn.js';
import { killAllProcesses } from '../../lib/process/registry.js';
import { discardChangedFiles } from '../../lib/git.js';
import {
  deserializeChangedFilesBaseline,
  inferTaskAcceptedChangedFiles,
} from './changed-files-baseline.js';
import { restoreDirtyFilesFromSnapshot } from './approval/file-snapshots.js';
import { withSignalHandlers } from './signals.js';
import { createClearQueueHandler, createQueueHandler } from './queue.js';
import { createWriteSequencer } from './serial-executor.js';
import type { Planner } from '../planners/types.js';
import type { WorkflowSinks } from './types.js';

export type SaveFinalSessionOpts = {
  projectDir: string;
  sessionId: string;
  feature: string;
  startTime: number;
  status: Session['status'];
  summary: Summary;
  preserveActive?: boolean | undefined;
};

export function shouldPreserveActiveState(state: WorkflowState | null): boolean {
  if (!state) return false;
  return state.pendingRecovery !== undefined || isResumable(state);
}

export function saveFinalSession(opts: SaveFinalSessionOpts): void {
  try {
    const session: Session = {
      id: opts.sessionId,
      feature: opts.feature,
      startedAt: opts.startTime,
      completedAt: Date.now(),
      stateVersion: CURRENT_STATE_VERSION,
      status: opts.status,
      summary: opts.summary,
    };
    saveSummary({ projectDir: opts.projectDir, sessionId: opts.sessionId }, session);
    if (
      opts.status === 'complete' &&
      opts.summary.costBreakdown &&
      opts.summary.costBreakdown.isTotalActualCostKnown !== false
    ) {
      try {
        updateStats(opts.projectDir, {
          costBreakdown: opts.summary.costBreakdown,
          totalTasks: opts.summary.totalTasks,
          completedByLocal: opts.summary.completedByLocal,
          escalatedToPlanner: opts.summary.escalatedToPlanner,
          providerCosts: opts.summary.costBreakdown.providerCosts,
        });
      } catch {
        // stats update is best-effort; don't fail session save
      }
    }
    if (!opts.preserveActive)
      clearActive({ projectDir: opts.projectDir, sessionId: opts.sessionId });
  } catch (err) {
    warnError('Failed to save final session', err);
  }
}

// On interrupt the implementer may already have written several files of a multi-file
// task (agent/cli runners write directly), so rolling back only `task.file` would leave
// siblings dirty and feed the resumed run a partially-applied tree. Newer states carry a
// task-start snapshot so attributed files can be restored to their exact pre-task content,
// including user-dirty files. Older persisted states fall back to discarding only files
// the task introduced, preserving the previous compatibility behavior.
async function rollBackInterruptedTask(
  projectDir: string,
  currentTask: Pick<Task, 'file' | 'action'>,
  trackedState: WorkflowState | undefined,
): Promise<void> {
  const inFlight = trackedState?.tasks[trackedState.currentTaskIndex];
  const baseline =
    trackedState?.changedFilesBaseline !== undefined
      ? deserializeChangedFilesBaseline(trackedState.changedFilesBaseline)
      : undefined;
  const attributed =
    inFlight !== undefined && inFlight.file === currentTask.file
      ? await inferTaskAcceptedChangedFiles(projectDir, inFlight, baseline?.head ?? null)
      : [currentTask.file];
  if (baseline?.activeTaskSnapshot !== undefined) {
    await restoreDirtyFilesFromSnapshot(projectDir, baseline.activeTaskSnapshot, attributed);
    return;
  }
  const taskIntroduced = baseline
    ? attributed.filter((file) => !baseline.fingerprints.has(file))
    : attributed;
  if (taskIntroduced.length === 0) return;
  await discardChangedFiles(projectDir, taskIntroduced);
}

export async function shutdownWorkflow(
  projectDir: string,
  sessionId: string,
  getTrackedState: () => WorkflowState | undefined,
  getCurrentTask: () => Pick<Task, 'file' | 'action'> | undefined,
): Promise<void> {
  killAllProcesses();
  const trackedState = getTrackedState();
  if (trackedState) {
    try {
      saveState({ projectDir, sessionId }, trackedState);
    } catch (err) {
      warnError('Failed to save state during shutdown', err);
    }
  }
  const currentTask = getCurrentTask();
  if (currentTask) {
    try {
      await rollBackInterruptedTask(projectDir, currentTask, trackedState);
    } catch (err) {
      warnError('Failed to discard changes during shutdown', err);
    }
  }
}

export type WithShutdownHandlersOpts = {
  projectDir: string;
  sessionId: string;
  getTrackedState: () => WorkflowState | undefined;
  getCurrentTask: () => Pick<Task, 'file' | 'action'> | undefined;
};

// The TUI host (cli/render.ts) installs its own OS-signal handlers that exit the process,
// and on a fullscreen `kill` they would race the workflow's signal-driven rollback to
// completion — terminating before it runs. The host awaits this before exiting so the same
// shutdown that headless runs uses also runs under the TUI. The runner is memoized so the
// signal path and the host's await share one rollback instead of discarding twice.
let activeWorkflowShutdown: (() => Promise<void>) | undefined;

export function awaitActiveWorkflowShutdown(): Promise<void> {
  return activeWorkflowShutdown?.() ?? Promise.resolve();
}

export async function withShutdownHandlers(
  opts: WithShutdownHandlersOpts,
  fn: () => Promise<void>,
): Promise<{ cancelled: boolean }> {
  let pending: Promise<void> | undefined;
  const shutdown = () => {
    pending ??= shutdownWorkflow(
      opts.projectDir,
      opts.sessionId,
      opts.getTrackedState,
      opts.getCurrentTask,
    );
    return pending;
  };
  activeWorkflowShutdown = shutdown;
  try {
    return await withSignalHandlers(shutdown, fn);
  } finally {
    if (activeWorkflowShutdown === shutdown) activeWorkflowShutdown = undefined;
  }
}

export type InstallQueueHandlerOpts = {
  projectDir: string;
  sessionId: string;
  sinks: WorkflowSinks;
  getTrackedState: () => WorkflowState | undefined;
  setTrackedState: (s: WorkflowState) => void;
  bus: EventBus;
  config: Config;
  planner: Planner;
  signal?: AbortSignal | undefined;
};

export function installQueueHandler(opts: InstallQueueHandlerOpts): void {
  const serialize = createWriteSequencer();
  opts.sinks.setQueueHandler(
    createQueueHandler({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      getState: opts.getTrackedState,
      setState: opts.setTrackedState,
      bus: opts.bus,
      persistTranscript: opts.config.workflow.persistTranscript,
      planner: opts.planner,
      serialize,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    }),
  );
  opts.sinks.setClearQueueHandler?.(
    createClearQueueHandler({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      getState: opts.getTrackedState,
      setState: opts.setTrackedState,
      bus: opts.bus,
    }),
  );
}
