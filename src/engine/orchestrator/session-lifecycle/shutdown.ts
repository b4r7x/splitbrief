import type { SessionRef } from '../../../core/types/session-ref.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { warnStderr } from '../../../lib/warn.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { withSignalHandlers } from '../signals.js';
import { commitWorkflowState, readWorkflowStateHead, stateOpsError } from '../state-ops.js';

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
  if (committed.kind === 'conflict') throw stateOpsError.changedOnDisk(ref.sessionId);
  if (committed.kind === 'durability-uncertain') {
    throw stateOpsError.durabilityUncertain(ref.sessionId);
  }
}

export type WithShutdownHandlersOpts = {
  projectDir: string;
  sessionId: string;
  getTrackedState: () => WorkflowState | undefined;
  getCurrentTask: () => Pick<Task, 'suggestedFiles' | 'action'> | undefined;
};

export async function shutdownWorkflow(opts: WithShutdownHandlersOpts): Promise<void> {
  const { projectDir, sessionId } = opts;
  const trackedState = opts.getTrackedState();
  await killAllProcesses();
  if (trackedState !== undefined) {
    try {
      persistTrackedState({ projectDir, sessionId }, trackedState);
    } catch (err) {
      // The error says what happened to which file; a prefix would claim a failed save over a
      // state that was saved.
      warnStderr(toErrorMessage(err));
    }
  }
}

let activeWorkflowShutdown: (() => Promise<void>) | undefined;
let activeApplyRun: Promise<void> | undefined;
const activeApplyListeners = new Set<() => void>();

function setActiveApplyRun(run: Promise<void> | undefined): void {
  activeApplyRun = run;
  for (const listener of activeApplyListeners) listener();
}

/**
 * Registers this process's Apply until `run` settles. Apply cannot be cut safely, so shutdown
 * waits for it. A second Apply joins the first rather than replacing it.
 */
export function trackActiveApply<T>(run: Promise<T>): Promise<T> {
  const settled: Promise<void> = Promise.allSettled([activeApplyRun, run]).then(() => {
    if (activeApplyRun === settled) setActiveApplyRun(undefined);
  });
  setActiveApplyRun(settled);
  return run;
}

/** The Apply this process runs, resolving (never rejecting) once it settles; else `undefined`. */
export function activeApply(): Promise<void> | undefined {
  return activeApplyRun;
}

/** Calls `listener` each time this process starts or ends an Apply; returns the unsubscribe. */
export function onActiveApplyChange(listener: () => void): () => void {
  activeApplyListeners.add(listener);
  return () => {
    activeApplyListeners.delete(listener);
  };
}

export async function awaitActiveWorkflowShutdown(): Promise<void> {
  await activeApplyRun;
  await activeWorkflowShutdown?.();
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
