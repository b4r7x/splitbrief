import type { Phase } from '../../../core/schemas/enums.js';
import type { BriefReviewPromptKind } from '../../../core/schemas/brief-review-command.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { QueueHandler } from '../../../engine/orchestrator/types.js';
import { isRecord } from '../../../utils/type-guards.js';
import type { ApprovalGatePrompt, BriefReviewDraftSaveResult } from '../gates.js';
import type { createApprovalGate, createGate } from '../gates.js';
import { rpcError } from '../errors.js';
import type { createResponseWriter } from '../writer.js';

type ApprovalGate = ReturnType<typeof createApprovalGate>;
type MessageGate = ReturnType<typeof createGate<string>>;
type RecoveryGate = ReturnType<typeof createGate<string>>;
type ResponseWriter = ReturnType<typeof createResponseWriter>;

export function pendingQueueDepth(state: WorkflowState | null): number {
  return state?.messageQueue.filter(isQueuedMessagePendingDelivery).length ?? 0;
}

export function approvalTypeFromStatus(data: unknown): BriefReviewPromptKind | undefined {
  if (!isRecord(data)) return undefined;
  const approvalType = data.approvalType;
  if (approvalType === 'spec' || approvalType === 'plan' || approvalType === 'briefs') {
    return approvalType;
  }
  return undefined;
}

export function approvalFilePathFromStatus(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  return typeof data.filePath === 'string' ? data.filePath : undefined;
}

export function withApprovalPromptStatus(
  data: unknown,
  prompt: ApprovalGatePrompt | null,
): unknown {
  if (!isRecord(data) || prompt === null) return data;
  return {
    ...data,
    promptId: prompt.promptId,
    allowedCommands: prompt.allowedCommands,
  };
}

export function pendingGateType(
  approval: { isPending(): boolean },
  message: { isPending(): boolean },
  recovery: { isPending(): boolean },
): 'approval' | 'message' | 'recovery' | null {
  if (approval.isPending()) return 'approval';
  if (message.isPending()) return 'message';
  if (recovery.isPending()) return 'recovery';
  return null;
}

export type RpcStatusProjectionDeps = {
  readCurrentState: () => WorkflowState | null;
  getActiveSessionId: () => string | undefined;
  getCurrentPhase: () => Phase;
  getQueueHandler: () => QueueHandler | null;
  approvalGate: ApprovalGate;
  messageGate: MessageGate;
  recoveryGate: RecoveryGate;
  transportAborted: () => boolean;
  writer: ResponseWriter;
  isRpcClosed: () => boolean;
  saveBriefDraft: (tasksFilePath: string) => Promise<BriefReviewDraftSaveResult>;
};

export function createRpcStatusProjection(deps: RpcStatusProjectionDeps) {
  const writeStatus = () => {
    const state = deps.readCurrentState();
    const approvalPrompt = deps.approvalGate.pendingPrompt();
    deps.writer.status({
      sessionId: deps.getActiveSessionId() ?? null,
      phase: state?.phase ?? deps.getCurrentPhase(),
      state,
      queueDepth: pendingQueueDepth(state),
      queueReady: deps.getQueueHandler() !== null,
      pending: pendingGateType(deps.approvalGate, deps.messageGate, deps.recoveryGate),
      approvalPrompt,
      aborted: deps.transportAborted(),
    });
  };

  const waitForApproval = async (data: unknown) => {
    if (deps.isRpcClosed()) throw rpcError.transportClosed();
    const approvalType = approvalTypeFromStatus(data);
    const filePath = approvalFilePathFromStatus(data);
    const pending = deps.approvalGate.wait({
      approvalType,
      ...(approvalType === 'briefs' && filePath !== undefined
        ? { onSaveDraft: () => deps.saveBriefDraft(filePath) }
        : {}),
    });
    deps.writer.status(withApprovalPromptStatus(data, deps.approvalGate.pendingPrompt()));
    return pending;
  };

  const waitForMessage = async (data: unknown) => {
    if (deps.isRpcClosed()) throw rpcError.transportClosed();
    const pending = deps.messageGate.wait();
    deps.writer.status(data);
    return pending;
  };

  return { writeStatus, waitForApproval, waitForMessage };
}
