import type { SessionRef } from '../../../core/types/session-ref.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { warnError } from '../../../lib/warn.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { discardChangedFiles } from '../../../lib/git/files.js';
import {
  deserializeChangedFilesBaseline,
  inferTaskAcceptedChangedFiles,
} from '../changed-files-baseline.js';
import { restoreDirtyFilesFromSnapshot } from '../approval/file-snapshots/restore.js';
import { withSignalHandlers } from '../signals.js';
import { commitWorkflowState, readWorkflowStateHead } from '../state-ops.js';
import { error } from '../../../utils/error.js';

function persistTrackedState(ref: SessionRef, state: WorkflowState): void {
  const head = readWorkflowStateHead(ref);
  if (head !== null && (head.state.stateRevision ?? 0) !== (state.stateRevision ?? 0)) {
    return;
  }
  const committed = commitWorkflowState({
    ref,
    expected: head === null ? null : state,
    next: state,
  });
  if (committed.kind === 'conflict') {
    throw error(
      'state-persistence-conflict',
      'Workflow state changed before shutdown persistence committed.',
    );
  }
  if (committed.kind === 'durability-uncertain') {
    throw error(
      'state-persistence-durability-uncertain',
      'Workflow state durability is uncertain during shutdown.',
    );
  }
}

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

export type WithShutdownHandlersOpts = {
  projectDir: string;
  sessionId: string;
  getTrackedState: () => WorkflowState | undefined;
  getCurrentTask: () => Pick<Task, 'file' | 'action'> | undefined;
};

export async function shutdownWorkflow(opts: WithShutdownHandlersOpts): Promise<void> {
  const { projectDir, sessionId } = opts;
  const trackedState = opts.getTrackedState();
  await killAllProcesses();
  if (trackedState !== undefined) {
    try {
      persistTrackedState({ projectDir, sessionId }, trackedState);
    } catch (err) {
      warnError('Failed to save state during shutdown', err);
    }
  }
  const currentTask = opts.getCurrentTask();
  if (currentTask) {
    try {
      await rollBackInterruptedTask(projectDir, currentTask, trackedState);
    } catch (err) {
      warnError('Failed to discard changes during shutdown', err);
    }
  }
}

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
    pending ??= shutdownWorkflow(opts);
    return pending;
  };
  activeWorkflowShutdown = shutdown;
  try {
    return await withSignalHandlers(shutdown, fn);
  } finally {
    if (activeWorkflowShutdown === shutdown) activeWorkflowShutdown = undefined;
  }
}
