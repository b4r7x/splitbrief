import type { Phase } from '../../../core/schemas/enums.js';
import type { BriefRecoveryProjectionV1 } from '../../../core/schemas/brief-recovery/document.js';
import type { RecoveryResultV1 } from '../../../core/schemas/brief-recovery.js';
import {
  BriefReviewPromptKindSchema,
  type BriefReviewPromptKind,
} from '../../../core/schemas/brief-review-command.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { QueueHandler } from '../../../engine/orchestrator/types.js';
import { error } from '../../../utils/error.js';
import { isRecord } from '../../../utils/type-guards.js';
import {
  isArtifactApprovalStatus,
  type ApprovalGatePrompt,
  type ArtifactApprovalStatus,
} from '../gates.js';
import type { createApprovalGate, createGate } from '../gates.js';
import { rpcError } from '../errors.js';
import type { createResponseWriter } from '../writer.js';

type ApprovalGate = ReturnType<typeof createApprovalGate>;
type MessageGate = ReturnType<typeof createGate<string>>;
type RecoveryGate = ReturnType<typeof createGate<string>>;
type ResponseWriter = ReturnType<typeof createResponseWriter>;

export type RpcRecoveryStatus = Readonly<{
  briefRecovery: BriefRecoveryProjectionV1 | null;
  result: RecoveryResultV1 | null;
}>;

const rpcStatusError = {
  invalidArtifactApproval: () =>
    error('rpc-artifact-approval-invalid', 'Artifact approval payload is invalid.'),
  artifactApprovalUndeliverable: () =>
    error('rpc-artifact-approval-undeliverable', 'Artifact approval could not be delivered.'),
} as const;

export function pendingQueueDepth(state: WorkflowState | null): number {
  return state?.messageQueue.filter(isQueuedMessagePendingDelivery).length ?? 0;
}

export function approvalTypeFromStatus(data: unknown): BriefReviewPromptKind | undefined {
  if (!isRecord(data)) return undefined;
  const parsed = BriefReviewPromptKindSchema.safeParse(data.approvalType);
  return parsed.success ? parsed.data : undefined;
}

function artifactApprovalStatusFromStatus(data: unknown): ArtifactApprovalStatus | undefined {
  return isArtifactApprovalStatus(data) ? data : undefined;
}

function artifactApprovalStatusFromPrompt(
  prompt: ApprovalGatePrompt | null,
): ArtifactApprovalStatus | null {
  if (prompt?.approvalType !== 'artifact' || prompt.artifactReview === undefined) return null;
  const status: ArtifactApprovalStatus = {
    pending: 'approval',
    approvalType: 'artifact',
    review: prompt.artifactReview,
  };
  return isArtifactApprovalStatus(status) ? status : null;
}

function approvalPromptStatus(prompt: ApprovalGatePrompt | null): object | null {
  if (prompt === null) return null;
  return {
    promptId: prompt.promptId,
    ...(prompt.approvalType !== undefined && { approvalType: prompt.approvalType }),
    allowedCommands: prompt.allowedCommands,
  };
}

export function withApprovalPromptStatus(
  data: unknown,
  prompt: ApprovalGatePrompt | null,
): unknown {
  if (!isRecord(data) || prompt === null) return data;
  const artifactStatus = artifactApprovalStatusFromPrompt(prompt);
  if (artifactStatus !== null) {
    return {
      ...artifactStatus,
      promptId: prompt.promptId,
      allowedCommands: prompt.allowedCommands,
    };
  }
  return {
    ...data,
    promptId: prompt.promptId,
    allowedCommands: prompt.allowedCommands,
  };
}

export function pendingGateType(gates: {
  approval: { isPending(): boolean };
  message: { isPending(): boolean };
  recovery: { isPending(): boolean };
}): 'approval' | 'message' | 'recovery' | null {
  if (gates.approval.isPending()) return 'approval';
  if (gates.message.isPending()) return 'message';
  if (gates.recovery.isPending()) return 'recovery';
  return null;
}

/**
 * Add the owner-produced recovery view to a transport status without deriving
 * anything from events, task files, or the legacy workflow phase.
 */
export function withRecoveryStatus(data: unknown, recovery: RpcRecoveryStatus | null): unknown {
  if (!isRecord(data) || recovery === null) return data;
  return {
    ...data,
    briefRecovery: recovery.briefRecovery,
    result: recovery.result,
  };
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
  getRecoveryProjection?: () => BriefRecoveryProjectionV1 | null;
  getRecoveryResult?: () => RecoveryResultV1 | null;
};

function recoveryStatusFromDeps(deps: RpcStatusProjectionDeps): RpcRecoveryStatus | null {
  if (deps.getRecoveryProjection === undefined && deps.getRecoveryResult === undefined) {
    return null;
  }
  const result = deps.getRecoveryResult?.() ?? null;
  return {
    briefRecovery: deps.getRecoveryProjection?.() ?? result?.projection ?? null,
    result,
  };
}

export function createRpcStatusProjection(deps: RpcStatusProjectionDeps) {
  const writeStatus = () => {
    const state = deps.readCurrentState();
    const recovery = recoveryStatusFromDeps(deps);
    const approvalPrompt = deps.approvalGate.pendingPrompt();
    const artifactStatus = artifactApprovalStatusFromPrompt(approvalPrompt);
    const artifactPromptStatus =
      artifactStatus === null || approvalPrompt === null
        ? null
        : {
            ...artifactStatus,
            promptId: approvalPrompt.promptId,
            allowedCommands: approvalPrompt.allowedCommands,
          };
    const delivered = deps.writer.status({
      sessionId: deps.getActiveSessionId() ?? null,
      phase: state?.phase ?? deps.getCurrentPhase(),
      state,
      queueDepth: pendingQueueDepth(state),
      queueReady: deps.getQueueHandler() !== null,
      pending: pendingGateType({
        approval: deps.approvalGate,
        message: deps.messageGate,
        recovery: deps.recoveryGate,
      }),
      approvalPrompt: approvalPromptStatus(approvalPrompt),
      aborted: deps.transportAborted(),
      ...(recovery !== null && {
        briefRecovery: recovery.briefRecovery,
        result: recovery.result,
      }),
      ...(artifactPromptStatus !== null && artifactPromptStatus),
    });
    if (artifactPromptStatus !== null && !delivered) {
      deps.approvalGate.reject(rpcStatusError.artifactApprovalUndeliverable());
    }
  };

  const waitForApproval = async (data: unknown) => {
    if (deps.isRpcClosed()) throw rpcError.transportClosed();
    const approvalType = approvalTypeFromStatus(data);
    const artifactStatus = artifactApprovalStatusFromStatus(data);
    if (approvalType === 'artifact' && artifactStatus === undefined) {
      throw rpcStatusError.invalidArtifactApproval();
    }
    const pending = deps.approvalGate.wait({
      approvalType,
      ...(artifactStatus !== undefined && { artifactReview: artifactStatus.review }),
    });
    const recovery = recoveryStatusFromDeps(deps);
    const delivered = deps.writer.status(
      withRecoveryStatus(
        withApprovalPromptStatus(data, deps.approvalGate.pendingPrompt()),
        recovery,
      ),
    );
    if (artifactStatus !== undefined && !delivered) {
      deps.approvalGate.reject(rpcStatusError.artifactApprovalUndeliverable());
    }
    return pending;
  };

  const waitForMessage = async (data: unknown) => {
    if (deps.isRpcClosed()) throw rpcError.transportClosed();
    const pending = deps.messageGate.wait();
    deps.writer.status(withRecoveryStatus(data, recoveryStatusFromDeps(deps)));
    return pending;
  };

  return { writeStatus, waitForApproval, waitForMessage };
}
