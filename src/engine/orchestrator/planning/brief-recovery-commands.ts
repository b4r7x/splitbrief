import { randomUUID } from 'node:crypto';
import type { ApprovalReviewResult } from '../../../core/approval/types.js';
import type {
  BriefRecoveryProjectionV1,
  NormalBriefRecoveryV1,
} from '../../../core/schemas/brief-recovery/document.js';
import type {
  BriefRecoveryCommand,
  QueueBriefInput,
  QueueResultV1,
  RecoveryResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { sha256Hex } from '../../../utils/sha256.js';

export type RecoveryCursor = {
  authority: StateAuthorityReceipt;
  projection: BriefRecoveryProjectionV1 | undefined;
  epochId: string | null;
  base: BriefRecoveryProjectionV1['activeBrief'];
  activeOperationId: string | null;
  inputIds: readonly string[];
  nextInputSequence: number;
};

export type RecoveryCursorSeed = {
  authority: StateAuthorityReceipt;
  projection?: BriefRecoveryProjectionV1 | undefined;
  operationId?: string | null | undefined;
  nextInputSequence?: number | undefined;
};

export type RetryReviewResult = {
  approved: false;
  action: 'retry';
  operationId?: string | undefined;
  intentHash?: string | undefined;
};

export type ApprovalDecision = ApprovalReviewResult | RetryReviewResult;

export function isNormalRecovery(
  recovery: WorkflowState['briefRecovery'],
): recovery is NormalBriefRecoveryV1 {
  return (
    recovery !== undefined &&
    recovery !== null &&
    recovery.status !== 'storage-blocked' &&
    recovery.status !== 'rejected'
  );
}

export function initialCursor(state: WorkflowState, seed: RecoveryCursorSeed): RecoveryCursor {
  const normal = isNormalRecovery(state.briefRecovery) ? state.briefRecovery : null;
  const projection = seed.projection;
  return {
    authority: seed.authority,
    projection,
    epochId: projection?.epochId ?? normal?.epochId ?? null,
    base: projection?.activeBrief ?? normal?.activeBrief ?? null,
    activeOperationId:
      projection?.activeOperation?.operationId ??
      normal?.activeOperationId ??
      seed.operationId ??
      null,
    inputIds:
      normal === null
        ? (projection?.queuedInputs.ids ?? [])
        : normal.inputs
            .filter((input) => input.state === 'queued' || input.state === 'carried')
            .map((input) => input.inputId),
    nextInputSequence: seed.nextInputSequence ?? normal?.nextInputSequence ?? 1,
  };
}

function semanticProjectionFingerprint(projection: BriefRecoveryProjectionV1): string {
  return JSON.stringify({
    status: projection.status,
    blocker: projection.blocker,
    activeBrief:
      projection.activeBrief === null
        ? null
        : { hash: projection.activeBrief.hash, path: projection.activeBrief.path },
    matchingReport:
      projection.matchingReport === null
        ? null
        : {
            briefHash: projection.matchingReport.briefHash,
            report: {
              hash: projection.matchingReport.report.hash,
              path: projection.matchingReport.report.path,
            },
            ruleVersion: projection.matchingReport.ruleVersion,
            issues: projection.matchingReport.issues,
          },
    queuedInputState: {
      carriedCount: projection.queuedInputs.carriedCount,
      heldCount: projection.queuedInputs.heldCount,
      releasedCount: projection.queuedInputs.releasedCount,
    },
    allowedActions: projection.allowedActions,
  });
}

export function updateCursor(
  cursor: RecoveryCursor,
  result: RecoveryResultV1 | QueueResultV1,
  inputIds: readonly string[],
  authority: StateAuthorityReceipt,
): boolean {
  const previous = cursor.projection;
  cursor.authority = {
    ...cursor.authority,
    ...authority,
    stateRevision: result.projection.stateRevision,
  };
  cursor.projection = result.projection;
  cursor.epochId = result.projection.epochId;
  cursor.base = result.projection.activeBrief;
  cursor.activeOperationId = result.projection.activeOperation?.operationId ?? null;
  cursor.inputIds = inputIds;
  if (result.kind === 'accepted' && 'input' in result) cursor.nextInputSequence += 1;
  return (
    previous === undefined ||
    semanticProjectionFingerprint(previous) !== semanticProjectionFingerprint(result.projection)
  );
}

function commandBase(cursor: RecoveryCursor): {
  epochId: string;
  base: NonNullable<RecoveryCursor['base']>;
} | null {
  if (cursor.epochId === null || cursor.base === null) return null;
  return { epochId: cursor.epochId, base: cursor.base };
}

export function retryCommand(
  cursor: RecoveryCursor,
  result: RetryReviewResult,
  feedbackInputIds?: readonly string[],
): BriefRecoveryCommand | null {
  const identity = commandBase(cursor);
  if (identity === null) return null;
  const diagnostic = sha256Hex(
    JSON.stringify(
      cursor.projection?.blocker ?? { status: cursor.projection?.status ?? 'blocked' },
    ),
  );
  const operationId = result.operationId ?? `retry-${randomUUID()}`;
  const frozenInputIds = feedbackInputIds ?? cursor.inputIds;
  const intentHash =
    result.intentHash ??
    sha256Hex(
      `${operationId}:${identity.base.hash}:${diagnostic}:${feedbackInputIds === undefined ? 'retry' : 'feedback-revision'}:${frozenInputIds.join(',')}`,
    );
  return {
    version: 1,
    sessionId: cursor.authority.sessionId,
    epochId: identity.epochId,
    operationId,
    base: identity.base,
    intentHash,
    action: 'retry',
    diagnosticFingerprint: diagnostic,
    frozenInputIds,
    ...(feedbackInputIds === undefined ? {} : { attemptKind: 'feedback-revision' as const }),
  };
}

export function rejectionCommand(
  cursor: RecoveryCursor,
): Extract<BriefRecoveryCommand, { action: 'reject' }> | null {
  const identity = commandBase(cursor);
  if (identity === null) return null;
  return {
    version: 1,
    sessionId: cursor.authority.sessionId,
    epochId: identity.epochId,
    operationId: `reject-${randomUUID()}`,
    base: identity.base,
    intentHash: sha256Hex(`reject:${identity.base.hash}`),
    action: 'reject',
    userIntentId: randomUUID(),
  };
}

export function editCommand(
  cursor: RecoveryCursor,
  briefText: string,
  inputId: string,
): Extract<BriefRecoveryCommand, { action: 'edit' }> | null {
  const identity = commandBase(cursor);
  if (identity === null) return null;
  return {
    version: 1,
    sessionId: cursor.authority.sessionId,
    epochId: identity.epochId,
    operationId: `edit-${inputId}`,
    base: identity.base,
    intentHash: sha256Hex(`edit:${identity.base.hash}:${briefText}`),
    action: 'edit',
    briefText,
    newInputId: inputId,
  };
}

export function queueCommand(
  cursor: RecoveryCursor,
  payload: string,
  source: QueueBriefInput['source'],
  inputId: string,
): QueueBriefInput | null {
  const identity = commandBase(cursor);
  if (identity === null || payload.length === 0) return null;
  return {
    sessionId: cursor.authority.sessionId,
    epochId: identity.epochId,
    inputId,
    sequence: cursor.nextInputSequence,
    kind: 'feedback',
    source,
    payload,
    base: identity.base,
    operationId: cursor.activeOperationId,
  };
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  if (typeof value !== 'object' || value === null) return false;
  if (!('approved' in value) || typeof value.approved !== 'boolean') return false;
  if (value.approved) return true;
  const action = 'action' in value ? value.action : undefined;
  if (action === undefined || action === 'edit' || action === 'retry') return true;
  return action === 'revise' && 'comment' in value && typeof value.comment === 'string';
}

export function isRetryDecision(result: ApprovalDecision): result is RetryReviewResult {
  return !result.approved && 'action' in result && result.action === 'retry';
}

export function isEditDecision(
  result: ApprovalDecision,
): result is Extract<ApprovalReviewResult, { action: 'edit' }> {
  return !result.approved && 'action' in result && result.action === 'edit';
}

export function isRevisionDecision(
  result: ApprovalDecision,
): result is Extract<ApprovalReviewResult, { action: 'revise' }> {
  return !result.approved && 'action' in result && result.action === 'revise';
}
