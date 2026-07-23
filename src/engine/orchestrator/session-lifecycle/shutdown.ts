import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { saveState } from '../../../core/state/persistence.js';
import { warnError } from '../../../lib/warn.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { discardChangedFiles } from '../../../lib/git/files.js';
import {
  deserializeChangedFilesBaseline,
  inferTaskAcceptedChangedFiles,
} from '../changed-files-baseline.js';
import { restoreDirtyFilesFromSnapshot } from '../approval/file-snapshots/restore.js';
import { withSignalHandlers } from '../signals.js';

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
