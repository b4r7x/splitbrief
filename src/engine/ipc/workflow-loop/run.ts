import { runWorkflow as runWorkflowDefault } from '../../orchestrator/run/workflow.js';
import type { RunWorkflowOptions } from '../../orchestrator/run/init.js';
import type { IpcWorkflowBridge } from '../workflow-bridge.js';
import { createServerArgsAttachmentDrain } from '../server-args.js';
import type { IpcServer } from '../server.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskId } from '../../../core/schemas/task.js';
import { buildDetachedRetryState } from '../retry-state.js';
import type { EventBus } from '../../events/types.js';
import { transitionAndSave } from '../../orchestrator/state-ops.js';
import { refreshWorkflowAuthority } from '../../orchestrator/run/authority.js';
import { assertPromptResponse, makeCallbacks } from './prompts.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import { projectBriefRecovery } from '../../orchestrator/planning/brief-recovery-controller.js';
import { recoveryViewOf } from '../../orchestrator/planning/brief-owner-projection.js';
import {
  buildPausedSummary,
  loadOwnerWorkflowState,
  resolveDetachedPendingRecovery,
  workflowLoopResumeAuthority,
  type WorkflowLoopContext,
} from './recovery.js';

export type { WorkflowLoopContext };

export type RunWorkflowFn = (options: RunWorkflowOptions) => Promise<Summary>;

function refreshOwnerAuthority(ctx: WorkflowLoopContext, state: WorkflowState): void {
  const current = workflowLoopResumeAuthority(ctx);
  if (current === undefined) return;
  const refreshed = refreshWorkflowAuthority(ctx.prepared.session.ref, current.receipt, state);
  if (ctx.resumeAuthority !== undefined) {
    ctx.resumeAuthority = { ...ctx.resumeAuthority, receipt: refreshed };
  } else {
    ctx.authority = refreshed;
  }
}

function persistDetachedRetryState(ctx: WorkflowLoopContext, state: WorkflowState): WorkflowState {
  const authority = workflowLoopResumeAuthority(ctx)?.receipt;
  if (authority === undefined) {
    // A context without an owner receipt is retained for the legacy unit-test
    // harness. It cannot write session state; the next owner hydration remains
    // the authority for a real detached process.
    return buildDetachedRetryState(state);
  }

  const ref = ctx.prepared.session.ref;
  let next = state;
  const failedTasks = state.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.status === 'failed')
    .sort((left, right) => right.index - left.index);

  for (const { task } of failedTasks) {
    next = transitionAndSave(
      ref,
      next,
      { type: 'RESET_TASK', taskId: task.id },
      { expectedRevision: next.stateRevision, authority },
    );
  }

  if (next.pendingRecovery !== undefined) {
    next = transitionAndSave(
      ref,
      next,
      { type: 'RESOLVE_PENDING_RECOVERY' },
      { expectedRevision: next.stateRevision, authority },
    );
  }
  refreshOwnerAuthority(ctx, next);
  return next;
}

function readBriefRecoveryProjection(
  ctx: WorkflowLoopContext,
): BriefRecoveryProjectionV1 | undefined {
  const state = loadOwnerWorkflowState(ctx);
  if (state === undefined || state.briefRecovery === undefined || state.briefRecovery === null) {
    return undefined;
  }
  return projectBriefRecovery({
    sessionId: ctx.prepared.session.ref.sessionId,
    now: new Date().toISOString(),
    state: recoveryViewOf(state),
  });
}

export async function runWorkflowLoop(
  ctx: WorkflowLoopContext,
  ipcServer: IpcServer,
  ipcBridge: IpcWorkflowBridge,
  ipcBus: EventBus,
  runWorkflow: RunWorkflowFn = runWorkflowDefault,
): Promise<Summary> {
  const config = ctx.prepared.config;
  if (ctx.observerProjection !== undefined) {
    return buildPausedSummary(ctx, ctx.observerProjection, config);
  }

  let stateForRun: WorkflowState | undefined = loadOwnerWorkflowState(ctx);
  let retryProfileOverride: string | undefined;
  let retryProfileOverrideTaskId: TaskId | undefined;
  const drainPendingAttachments = createServerArgsAttachmentDrain(ctx.attachments);

  while (true) {
    if (stateForRun?.pendingRecovery) {
      const recovery = await resolveDetachedPendingRecovery(
        ctx,
        ipcServer,
        ipcBus,
        config,
        stateForRun,
      );
      if (!recovery.shouldRun) {
        refreshOwnerAuthority(ctx, recovery.state);
        return buildPausedSummary(ctx, recovery.state, config);
      }
      stateForRun = recovery.state;
      refreshOwnerAuthority(ctx, stateForRun);
      retryProfileOverride = recovery.retryProfileOverride;
      retryProfileOverrideTaskId = recovery.retryProfileOverrideTaskId;
    }

    const summary = await runWorkflow({
      prepared: ctx.prepared,
      eventBus: ipcBus,
      sinks: ipcBridge.sinks,
      signal: ipcBridge.signal,
      drainPendingAttachments,
      callbacks: makeCallbacks(ipcServer, {
        readBriefRecovery: () => readBriefRecoveryProjection(ctx),
      }),
      ...(stateForRun !== undefined && { savedState: stateForRun }),
      ...(retryProfileOverride !== undefined && { retryProfileOverride }),
      ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
    });
    retryProfileOverride = undefined;
    retryProfileOverrideTaskId = undefined;

    const saved = loadOwnerWorkflowState(ctx);
    if (saved?.pendingRecovery || saved?.rewindPending) {
      stateForRun = saved;
      continue;
    }

    // Never fall back to the boot-time state (or undefined) at the failure prompt — that
    // re-plans from scratch and re-runs already-completed tasks. Carry the persisted state.
    stateForRun = saved ?? stateForRun;

    const completedTasks = summary.completedByLocal + summary.escalatedToPlanner + summary.skipped;
    const isIncomplete = summary.totalTasks > 0 && completedTasks < summary.totalTasks;
    if (summary.failed === 0 && !isIncomplete) {
      return summary;
    }

    const response = assertPromptResponse(
      await ipcServer.requestClientPrompt({
        kind: 'recovery_needed',
        issue: {
          id: 'workflow-failure',
          reason: 'implementation-error' as const,
          phase: stateForRun?.phase ?? 'complete',
          files: [],
          affectedTaskIds: [],
          availableActions: ['retry-same-worker' as const, 'abort-workflow' as const],
          recommendedAction: 'retry-same-worker' as const,
        },
      }),
      'recovery_needed',
    );

    if (response.action === 'abort-workflow') {
      return summary;
    }

    if (stateForRun) {
      stateForRun = persistDetachedRetryState(ctx, stateForRun);
    }
  }
}
