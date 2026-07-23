import { loadState } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskId } from '../../../core/schemas/task.js';
import { RecoveryActionSchema } from '../../../core/schemas/enums.js';
import { projectIpcRecoveryIssue } from '../../../core/schemas/recovery/ipc.js';
import { DEFAULT_WORKFLOW_MODE, type Config } from '../../../core/schemas/config.js';
import { applyRecoveryAction } from '../../orchestrator/recovery/actions.js';
import {
  finalizeRecoveryResult,
  loadPendingRecoveryState,
} from '../../orchestrator/recovery/driver.js';
import { publishRecoveryPrompted } from '../../orchestrator/events.js';
import { buildSummary } from '../../orchestrator/summary/build.js';
import { runPricingIdentity } from '../../../core/providers/pricing-identity.js';
import type { EventBus } from '../../events/types.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { assertPromptResponse } from './prompts.js';
import type { IpcServer } from '../server.js';
import type { IpcServerAttachment } from '../server-args.js';

export type WorkflowLoopContext = {
  projectDir: string;
  sessionId: string;
  feature: string;
  plannerContext?: string | undefined;
  allowHooks?: boolean | undefined;
  allowRepoRunners?: boolean | undefined;
  attachments?: IpcServerAttachment[] | undefined;
};

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

export async function resolveDetachedPendingRecovery(
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

export function buildPausedSummary(
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
