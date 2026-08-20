import { loadStateForResume } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskId } from '../../../core/schemas/task.js';
import { RecoveryActionSchema } from '../../../core/schemas/enums.js';
import { projectIpcRecoveryIssue } from '../../../core/schemas/recovery/ipc.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import { applyRecoveryAction } from '../../orchestrator/recovery/actions.js';
import { finalizeRecoveryResult } from '../../orchestrator/recovery/driver.js';
import { publishRecoveryPrompted } from '../../orchestrator/events.js';
import { buildSummary } from '../../orchestrator/summary/build.js';
import { runPricingIdentity } from '../../../core/providers/pricing-identity.js';
import type { EventBus } from '../../events/types.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { assertPromptResponse } from './prompts.js';
import type { IpcServer } from '../server.js';
import type { IpcServerAttachment } from '../server-args.js';
import type { PreparedExecution } from '../../runners/prepared-execution.js';
import type { ResumeLoadAuthority, StateAuthorityReceipt } from '../../../core/state/types.js';
import { error } from '../../../utils/error.js';

type PreparedConfig = PreparedExecution['config'];

export type WorkflowLoopContext = {
  prepared: PreparedExecution;
  attachments?: IpcServerAttachment[] | undefined;
  /** The usable receipt held by the process hosting the workflow owner. */
  authority?: StateAuthorityReceipt | undefined;
  /**
   * A receipt-bearing loader supplied by startup when it already knows whether a v3
   * promotion occurred. Keeping this as the full loader authority avoids making the
   * workflow loop infer migration state from a raw snapshot.
   */
  resumeAuthority?: Extract<ResumeLoadAuthority, { kind: 'fenced' }> | undefined;
  /**
   * Attached clients are observers. They receive the owner's validated v4 projection
   * and must not hydrate, migrate, or write the session locally.
   */
  observerProjection?: WorkflowState | undefined;
};

export type FencedWorkflowLoopAuthority = Extract<ResumeLoadAuthority, { kind: 'fenced' }>;

/**
 * Resolve the authority passed through the IPC hand-off into the resume seam's
 * canonical fenced form. A bare receipt is accepted for callers that do not need
 * to report a v3 promotion; startup may pass the complete form when it does.
 */
export function workflowLoopResumeAuthority(
  ctx: WorkflowLoopContext,
): FencedWorkflowLoopAuthority | undefined {
  if (ctx.resumeAuthority !== undefined) return ctx.resumeAuthority;
  if (ctx.authority === undefined) return undefined;
  return {
    kind: 'fenced',
    receipt: ctx.authority,
    promotedFromVersion: null,
  };
}

function invalidResumeError(
  ref: PreparedExecution['session']['ref'],
  result: Extract<ReturnType<typeof loadStateForResume>, { kind: 'invalid' }>,
): Error {
  return error(
    'workflow-state-invalid',
    `Cannot resume IPC workflow ${ref.sessionId}: ${result.code} state (${result.message}).`,
  );
}

/**
 * Hydrate only on the owner side. The observer branch deliberately returns its
 * supplied projection and never invokes the persistence seam.
 */
export function loadOwnerWorkflowState(ctx: WorkflowLoopContext): WorkflowState | undefined {
  if (ctx.observerProjection !== undefined) return ctx.observerProjection;
  const authority = workflowLoopResumeAuthority(ctx);
  if (authority === undefined) return undefined;

  const result = loadStateForResume({
    ref: ctx.prepared.session.ref,
    authority,
  });
  if (result.kind === 'invalid') {
    throw invalidResumeError(ctx.prepared.session.ref, result);
  }
  return result.kind === 'loaded' ? result.state : undefined;
}

function pendingRecoveryState(
  ctx: WorkflowLoopContext,
  fallback: WorkflowState,
):
  | { pending: true; state: WorkflowState; issue: NonNullable<WorkflowState['pendingRecovery']> }
  | {
      pending: false;
      state: WorkflowState;
    } {
  const state = loadOwnerWorkflowState(ctx) ?? fallback;
  if (state.pendingRecovery) {
    return { pending: true, state, issue: state.pendingRecovery };
  }
  return { pending: false, state };
}

type DetachedRecoveryResolution = {
  shouldRun: boolean;
  state: WorkflowState;
  retryProfileOverride?: string | undefined;
  retryProfileOverrideTaskId?: TaskId | undefined;
};

type DetachedRecoveryOutcome =
  | { ok: true; resolution: DetachedRecoveryResolution }
  | { ok: false; blockedMessage: string };

function applyDetachedRecoveryAction(
  ctx: WorkflowLoopContext,
  bus: EventBus,
  config: PreparedConfig,
  state: WorkflowState,
  action: RecoveryAction,
): DetachedRecoveryOutcome {
  const { ref, active } = ctx.prepared.session;
  const currentIssue = state.pendingRecovery;
  const selectedImplementerProfile = currentIssue?.selectedImplementerProfile;
  const retryProfileOverrideTaskId =
    currentIssue?.taskId ?? state.tasks[state.currentTaskIndex]?.id;
  const result = applyRecoveryAction({
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    state,
    action,
    bus,
    config,
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
  });
  if (!result.ok) return { ok: false, blockedMessage: result.message };
  if (result.status === 'aborted') {
    finalizeRecoveryResult({
      projectDir: ref.projectDir,
      sessionId: ref.sessionId,
      active,
      state: result.state,
      config,
      status: result.status,
    });
  }
  const retryProfileOverride = result.implementerProfile ?? selectedImplementerProfile;
  return {
    ok: true,
    resolution: {
      shouldRun: result.status !== 'paused' && result.status !== 'aborted',
      state: result.state,
      ...(retryProfileOverride !== undefined &&
        result.status === 'retry-current-task' && { retryProfileOverride }),
      ...(retryProfileOverride !== undefined &&
        result.status === 'retry-current-task' &&
        retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
    },
  };
}

export async function resolveDetachedPendingRecovery(
  ctx: WorkflowLoopContext,
  ipcServer: IpcServer,
  bus: EventBus,
  config: PreparedConfig,
  state: WorkflowState,
): Promise<DetachedRecoveryResolution> {
  if (ctx.observerProjection !== undefined) {
    return { shouldRun: false, state: ctx.observerProjection };
  }
  const pending = pendingRecoveryState(ctx, state);
  if (!pending.pending) return { shouldRun: true, state: pending.state };

  const applyAction = (action: RecoveryAction) => {
    const current = loadOwnerWorkflowState(ctx) ?? pending.state;
    return applyDetachedRecoveryAction(ctx, bus, config, current, action);
  };

  if (pending.issue.status === 'applying') {
    const action = pending.issue.selectedAction;
    if (!action) return { shouldRun: false, state: pending.state };
    const outcome = applyAction(action);
    if (!outcome.ok) return { shouldRun: false, state: pending.state };
    return outcome.resolution;
  }

  publishRecoveryPrompted(bus, pending.issue);

  while (true) {
    const response = assertPromptResponse(
      await ipcServer.requestClientPrompt({
        kind: 'recovery_needed',
        issue: projectIpcRecoveryIssue(pending.issue),
      }),
      'recovery_needed',
    );
    const parsed = RecoveryActionSchema.safeParse(response.action);
    if (!parsed.success || !pending.issue.availableActions.includes(parsed.data)) {
      continue;
    }
    const outcome = applyAction(parsed.data);
    if (!outcome.ok) {
      bus.publish({
        type: 'warning',
        ts: Date.now(),
        phase: pending.issue.phase,
        message: outcome.blockedMessage,
      });
      continue;
    }
    return outcome.resolution;
  }
}

export function buildPausedSummary(
  ctx: WorkflowLoopContext,
  state: WorkflowState,
  config: PreparedConfig,
): Summary {
  const ref = ctx.prepared.session.ref;
  const ident = runPricingIdentity(config);
  const parsedStart = Date.parse(state.startedAt);
  const startTime = Number.isFinite(parsedStart) ? parsedStart : Date.now();
  const plannerModel = state.plannerModel ?? ident.plannerModel;
  const implementerModel = state.implementerModel ?? ident.implementerModel;
  return buildSummary({
    feature: state.feature,
    state,
    startTime,
    plannerTool: state.plannerTool ?? ident.plannerTool,
    ...(plannerModel !== undefined ? { plannerModel } : {}),
    implementerTool: state.implementerTool ?? ident.implementerTool,
    ...(implementerModel !== undefined ? { implementerModel } : {}),
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
  });
}
