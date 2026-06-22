import { runWorkflow as runWorkflowDefault } from '../orchestrator/run/workflow.js';
import type { RunWorkflowOptions } from '../orchestrator/run/init.js';
import type { IpcWorkflowBridge } from './workflow-bridge.js';
import { createServerArgsAttachmentDrain, type IpcServerAttachment } from './server-args.js';
import type { IpcServer } from './server.js';
import type { IpcPromptResponse } from './protocol.js';
import { error } from '../../utils/error.js';
import type { OrchestratorCallbacks } from '../orchestrator/types.js';
import type { Summary } from '../../core/schemas/summary.js';
import { loadState, saveState } from '../../core/state/persistence.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskId } from '../../core/schemas/task.js';
import { RecoveryActionSchema } from '../../core/schemas/enums.js';
import { projectIpcRecoveryIssue } from '../../core/schemas/recovery.js';
import { DEFAULT_WORKFLOW_MODE, type Config } from '../../core/schemas/config.js';
import { applyRecoveryAction } from '../orchestrator/recovery/actions.js';
import {
  finalizeRecoveryResult,
  loadPendingRecoveryState,
} from '../orchestrator/recovery/driver.js';
import { publishRecoveryPrompted } from '../orchestrator/events.js';
import { buildDetachedRetryState } from './retry-state.js';
import { buildSummary } from '../orchestrator/summary.js';
import { runPricingIdentity } from '../../core/providers/pricing-identity.js';
import type { EventBus } from '../events/types.js';
import type { RecoveryAction } from '../../core/schemas/enums.js';
import { briefReviewCommandToApprovalReviewResult } from '../../core/schemas/brief-review-command.js';

export type WorkflowLoopContext = {
  projectDir: string;
  sessionId: string;
  feature: string;
  plannerContext?: string | undefined;
  allowHooks?: boolean | undefined;
  attachments?: IpcServerAttachment[] | undefined;
};

export type RunWorkflowFn = (options: RunWorkflowOptions) => Promise<Summary>;

const ipcWorkflowLoopError = {
  promptResponseKindMismatch: (expected: string, actual: string) =>
    error(
      'ipc-prompt-response-kind-mismatch',
      `IPC prompt response kind mismatch: expected ${expected}, got ${actual}`,
      { expected, actual },
    ),
  nonSettlingApprovalCommand: (action: string) =>
    error(
      'ipc-non-settling-approval-command',
      `IPC approval command does not resolve the prompt: ${action}`,
      { action },
    ),
} as const;

function assertPromptResponse<T extends IpcPromptResponse['kind']>(
  response: IpcPromptResponse,
  kind: T,
): Extract<IpcPromptResponse, { kind: T }> {
  if (response.kind !== kind) {
    throw ipcWorkflowLoopError.promptResponseKindMismatch(kind, response.kind);
  }
  return response as Extract<IpcPromptResponse, { kind: T }>;
}

export function makeCallbacks(ipcServer: IpcServer): OrchestratorCallbacks {
  return {
    onApprovalNeeded: async (approvalType: 'spec' | 'plan' | 'briefs', filePath: string) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'approval_needed', approvalType, filePath }),
        'approval_needed',
      );
      if ('command' in response) {
        const result = briefReviewCommandToApprovalReviewResult(response.command);
        if (result === null) {
          throw ipcWorkflowLoopError.nonSettlingApprovalCommand(response.command.action);
        }
        return result;
      }
      if (response.approved) return { approved: true };
      if (response.action === 'edit') {
        return response.comment !== undefined
          ? { approved: false, action: response.action, comment: response.comment }
          : { approved: false, action: response.action };
      }
      if (response.action === 'revise') {
        return {
          approved: false,
          action: response.action,
          comment: response.comment,
          ...(response.taskIds !== undefined && { taskIds: response.taskIds }),
        };
      }
      return { approved: false };
    },
    onUserEditConflict: async (conflict) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'user_edit_conflict', conflict }),
        'user_edit_conflict',
      );
      return response.selectedAction;
    },
    onQuestionAsked: async (question, num, total) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({
          kind: 'question_asked',
          question,
          num,
          total,
        }),
        'question_asked',
      );
      return response.answer;
    },
    onContinuationNeeded: async (partialResponse: string) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'continuation_needed', partialResponse }),
        'continuation_needed',
      );
      return response.text;
    },
    onTieredApproval: async (request) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'tiered_approval', request }),
        'tiered_approval',
      );
      return response.response;
    },
    onCostApprovalNeeded: async (prediction) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'cost_approval', prediction }),
        'cost_approval',
      );
      return response.approved;
    },
    onTaskReviewNeeded: async (request) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'task_review', request }),
        'task_review',
      );
      return response.response;
    },
    onComplete: () => undefined,
  };
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
  config: Config,
  state: WorkflowState,
  action: RecoveryAction,
): DetachedRecoveryOutcome {
  const currentIssue = state.pendingRecovery;
  const selectedImplementerProfile = currentIssue?.selectedImplementerProfile;
  const retryProfileOverrideTaskId =
    currentIssue?.taskId ?? state.tasks[state.currentTaskIndex]?.id;
  const result = applyRecoveryAction({
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    state,
    action,
    bus,
    config,
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
  });
  if (!result.ok) return { ok: false, blockedMessage: result.message };
  if (result.status === 'aborted') {
    finalizeRecoveryResult({
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
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

async function resolveDetachedPendingRecovery(
  ctx: WorkflowLoopContext,
  ipcServer: IpcServer,
  bus: EventBus,
  config: Config,
  state: WorkflowState,
): Promise<DetachedRecoveryResolution> {
  const pending = loadPendingRecoveryState(
    { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
    state,
  );
  if (!pending.pending) return { shouldRun: true, state: pending.state };
  if (pending.issue.status === 'paused') {
    return { shouldRun: false, state: pending.state };
  }

  const applyAction = (action: RecoveryAction) => {
    const current =
      loadState({ projectDir: ctx.projectDir, sessionId: ctx.sessionId }) ?? pending.state;
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

function buildPausedSummary(
  ctx: WorkflowLoopContext,
  state: WorkflowState,
  config: Config,
): Summary {
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
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
  });
}

export async function runWorkflowLoop(
  ctx: WorkflowLoopContext,
  ipcServer: IpcServer,
  ipcBridge: IpcWorkflowBridge,
  ipcBus: EventBus,
  config: Config,
  runWorkflow: RunWorkflowFn = runWorkflowDefault,
): Promise<Summary> {
  const sessionRef = { projectDir: ctx.projectDir, sessionId: ctx.sessionId };
  let stateForRun: WorkflowState | undefined = loadState(sessionRef) ?? undefined;
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
        return buildPausedSummary(ctx, recovery.state, config);
      }
      stateForRun = recovery.state;
      retryProfileOverride = recovery.retryProfileOverride;
      retryProfileOverrideTaskId = recovery.retryProfileOverrideTaskId;
    }

    const summary = await runWorkflow({
      feature: ctx.feature,
      plannerContext: ctx.plannerContext,
      projectDir: ctx.projectDir,
      config,
      allowHooks: ctx.allowHooks ?? false,
      sessionId: ctx.sessionId,
      eventBus: ipcBus,
      sinks: ipcBridge.sinks,
      signal: ipcBridge.signal,
      drainPendingAttachments,
      callbacks: makeCallbacks(ipcServer),
      ...(stateForRun !== undefined && { savedState: stateForRun }),
      ...(retryProfileOverride !== undefined && { retryProfileOverride }),
      ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
    });
    retryProfileOverride = undefined;
    retryProfileOverrideTaskId = undefined;

    const saved = loadState(sessionRef);
    if (saved?.pendingRecovery) {
      stateForRun = saved;
      continue;
    }
    if (saved?.rewindPending) {
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
      stateForRun = buildDetachedRetryState(stateForRun);
      saveState(sessionRef, stateForRun);
    }
  }
}
