import type { Config } from '../../core/schemas/config.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { BriefReviewCommandSchema } from '../../core/schemas/brief-review-command.js';
import type { EventBus } from '../../engine/events/types.js';
import type { ClearQueueHandler, QueueHandler } from '../../engine/orchestrator/types.js';
import type { PreparedExecution } from '../../engine/runners/prepared-execution.js';
import { createRuntimeCommands } from '../../core/runtime/commands/registry.js';
import { detectedModelFact, seatSupportsImages } from '../../core/runners/capabilities.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { executeRuntimeCommand } from '../../core/runtime/commands/dispatch.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { createRpcCommandContext } from './command-context.js';
import type { RpcCommand } from './types.js';
import type { RpcErrorOptions } from './writer.js';
import type { ApprovalGatePrompt, BriefReviewGateResult } from './gates.js';
import type { ResolvedRunConfig } from '../build-overrides.js';

export function createCommandHandler(deps: {
  projectDir: string;
  getPreparedExecution: () => PreparedExecution | null;
  getSessionId: () => string | undefined;
  getState: () => WorkflowState | null;
  getRunConfig: () => ResolvedRunConfig | null;
  setRunConfig: (config: ResolvedRunConfig) => void;
  reloadRunConfig: () => ResolvedRunConfig;
  setEffectiveConfig: (config: Config) => void;
  getApprovalEnabled?: (() => boolean) | undefined;
  setApprovalEnabled?: ((enabled: boolean) => void) | undefined;
  getPhase: () => Phase;
  getQueueHandler: () => QueueHandler | null;
  getClearQueueHandler: () => ClearQueueHandler | null;
  abort: (reason?: unknown) => void;
  bus: EventBus;
  approvalGate: {
    handle: (cmd: RpcCommand) => boolean;
    handleBriefReview: (
      command: Extract<RpcCommand, { type: 'brief_review' }>['command'],
      promptId?: string | undefined,
    ) => Promise<BriefReviewGateResult>;
  };
  messageGate: { resolve: (value: string) => boolean };
  receiveRecoveryAction: (action: string) => boolean;
  writeStatus: () => void;
  writer: {
    ack: (command: string, data?: unknown) => void;
    error: (message: string, options?: RpcErrorOptions) => void;
    status: (data: unknown) => void;
  };
  pendingQueueDepth: (state: WorkflowState | null) => number;
  requestRewind?: ((request: { target: 'spec' | 'plan'; comment?: string }) => boolean) | undefined;
  requestTaskRedo?: ((taskId: string) => boolean) | undefined;
}): (cmd: RpcCommand) => void {
  let runtimeChain: Promise<void> = Promise.resolve();
  let briefReviewChain: Promise<void> = Promise.resolve();

  const executeRpcRuntimeCommand = async (raw: string) => {
    const messages: string[] = [];
    const errors: string[] = [];
    const context = createRpcCommandContext({
      projectDir: deps.projectDir,
      getPreparedExecution: deps.getPreparedExecution,
      getSessionId: deps.getSessionId,
      getState: deps.getState,
      getRunConfig: deps.getRunConfig,
      setRunConfig: deps.setRunConfig,
      reloadRunConfig: deps.reloadRunConfig,
      setEffectiveConfig: deps.setEffectiveConfig,
      getApprovalEnabled: deps.getApprovalEnabled,
      setApprovalEnabled: deps.setApprovalEnabled,
      getPhase: deps.getPhase,
      queueHandler: deps.getQueueHandler,
      clearQueueHandler: deps.getClearQueueHandler,
      abort: deps.abort,
      bus: deps.bus,
      requestRewind: deps.requestRewind,
      requestTaskRedo: deps.requestTaskRedo,
      messages,
      errors,
      pendingQueueDepth: deps.pendingQueueDepth,
    });
    const planner = deps.getRunConfig()?.config.planner;
    await executeRuntimeCommand(createRuntimeCommands(context), raw, {
      screen: 'workflow',
      phase: deps.getPhase(),
      attached: false,
      plannerSupportsImages:
        planner !== undefined &&
        seatSupportsImages({
          runner: planner,
          detected: detectedModelFact(modelCacheStore.getDetection().providers, planner),
        }),
      onError: (message) => errors.push(message),
    });
    if (errors.length > 0) {
      for (const error of errors) {
        deps.writer.error(error, { transcriptSensitive: true, summary: 'Slash command failed.' });
      }
      return;
    }
    deps.writer.ack('slash', { command: raw, messages });
  };

  const briefReviewEcho = (
    cmd: Extract<RpcCommand, { type: 'brief_review' }>,
    prompt: ApprovalGatePrompt | null,
  ) => ({
    sessionId: cmd.command.sessionId,
    epochId: cmd.command.epochId,
    ...(cmd.id !== undefined && { id: cmd.id }),
    ...(cmd.operationId !== undefined
      ? { operationId: cmd.operationId }
      : cmd.command.action !== 'status'
        ? { operationId: cmd.command.operationId }
        : {}),
    promptId: cmd.promptId ?? prompt?.promptId ?? null,
    action: cmd.command.action,
  });

  const writeBriefReviewStatus = (
    cmd: Extract<RpcCommand, { type: 'brief_review' }>,
    result: Extract<BriefReviewGateResult, { status: 'status' }>,
  ) => {
    const prompt = result.prompt;
    deps.writer.status({
      ...briefReviewEcho(cmd, prompt),
      pending: prompt?.approvalType === 'briefs' ? 'brief_review' : null,
      approvalType: prompt?.approvalType ?? null,
      allowedCommands: prompt?.allowedCommands ?? [],
    });
  };

  const writeBriefReviewResult = (
    cmd: Extract<RpcCommand, { type: 'brief_review' }>,
    result: BriefReviewGateResult,
  ) => {
    if (result.status === 'status') {
      writeBriefReviewStatus(cmd, result);
      return;
    }
    if (result.status === 'saved') {
      deps.writer.ack('brief_review', {
        ...briefReviewEcho(cmd, result.prompt),
        status: 'saved',
        qualityPassed: result.draft.qualityPassed,
        qualityScore: result.draft.qualityScore,
        issueCount: result.draft.issueCount,
        taskCount: result.draft.taskCount,
      });
      return;
    }
    if (result.status === 'settled') {
      deps.writer.ack('brief_review', {
        ...briefReviewEcho(cmd, result.prompt),
        status: 'accepted',
      });
      return;
    }
    deps.writer.error(result.message, {
      transcriptSensitive: true,
      summary: 'Brief review command rejected.',
      data: {
        ...briefReviewEcho(cmd, result.prompt),
        status: 'rejected',
      },
    });
  };

  return (cmd: RpcCommand) => {
    if (cmd.type === 'approve' || cmd.type === 'reject' || cmd.type === 'regenerate') {
      if (deps.approvalGate.handle(cmd)) {
        deps.writer.ack(cmd.type);
        return;
      }
      deps.writer.error(`No pending approval gate for ${cmd.type}.`);
      return;
    }

    if (cmd.type === 'brief_review') {
      const parsedCommand = BriefReviewCommandSchema.safeParse(cmd.command);
      if (!parsedCommand.success) {
        deps.writer.error('Task Brief review command is invalid.', {
          transcriptSensitive: true,
          summary: 'Brief review command rejected.',
          data: {
            type: 'brief_review',
            status: 'rejected',
          },
        });
        return;
      }
      briefReviewChain = briefReviewChain
        .then(() => deps.approvalGate.handleBriefReview(parsedCommand.data, cmd.promptId))
        .then((result) => writeBriefReviewResult(cmd, result))
        .catch((err) => {
          deps.writer.error(toErrorMessage(err), {
            transcriptSensitive: true,
            summary: 'Brief review command rejected.',
            data: {
              ...briefReviewEcho(cmd, null),
              status: 'rejected',
            },
          });
        });
      return;
    }

    if (cmd.type === 'message') {
      if (deps.messageGate.resolve(cmd.text)) {
        deps.writer.ack('message');
        return;
      }
      const handler = deps.getQueueHandler();
      if (!handler) {
        deps.writer.error('Workflow queue is not ready.');
        return;
      }
      void Promise.resolve(handler(cmd.text, deps.getPhase()))
        .then((result) => {
          if (result.status === 'rejected') {
            deps.writer.error(result.message);
            return;
          }
          deps.writer.ack('message');
        })
        .catch((err) => {
          deps.writer.error(toErrorMessage(err));
        });
      return;
    }

    if (cmd.type === 'recovery') {
      if (deps.receiveRecoveryAction(cmd.action)) {
        deps.writer.ack('recovery', { action: cmd.action, queued: true });
      }
      return;
    }

    if (cmd.type === 'status') {
      deps.writeStatus();
      return;
    }

    if (cmd.type === 'abort') {
      deps.abort();
      deps.writer.ack('abort');
      return;
    }

    runtimeChain = runtimeChain
      .then(() => executeRpcRuntimeCommand(cmd.command))
      .catch((err) => {
        deps.writer.error(toErrorMessage(err), {
          transcriptSensitive: true,
          summary: 'Slash command failed.',
        });
      });
  };
}
