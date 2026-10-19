import type { SessionRef } from '../../../core/types/session-ref.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { warnError } from '../../../lib/warn.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
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
      warnError('Failed to save state during shutdown', err);
    }
  }
}

let activeWorkflowShutdown: (() => Promise<void>) | undefined;
let activeApplyRun: Promise<void> | undefined;

/**
 * Registers this process's at-rest Apply until `run` settles. Apply cannot be cut safely, so
 * shutdown waits for it. A second Apply joins the first rather than replacing it.
 */
export function trackActiveApply<T>(run: Promise<T>): Promise<T> {
  const settled: Promise<void> = Promise.allSettled([activeApplyRun, run]).then(() => {
    if (activeApplyRun === settled) activeApplyRun = undefined;
  });
  activeApplyRun = settled;
  return run;
}

/** The at-rest Apply this process runs, resolving (never rejecting) once it settles; else `undefined`. */
export function activeApply(): Promise<void> | undefined {
  return activeApplyRun;
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
