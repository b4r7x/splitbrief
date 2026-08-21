import type {
  BriefRecoveryProjectionV1,
  RecoveryResultV1,
} from '../../../core/schemas/brief-recovery.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EventBus } from '../../../engine/events/types.js';
import { truncateByChars } from '../../../utils/truncate.js';
import type { BriefReviewDraftSaveResult } from '../gates.js';

const RPC_DRAFT_SAVE_ERROR_MAX_CHARS = 2000;

function boundedDraftSaveError(message: string): string {
  return truncateByChars(message, RPC_DRAFT_SAVE_ERROR_MAX_CHARS);
}

export type RpcBriefReviewDraftDeps = {
  resolveSessionId: () => string | undefined;
  /**
   * The owner supplies this callback.  RPC only carries the file identity to
   * the owner; it does not parse a draft or decide whether the Brief is ready.
   */
  dispatchBriefReview?: (
    input: RpcBriefReviewDraftDispatchInput,
  ) => Promise<RpcBriefReviewDraftControllerResult>;

  /** Compatibility fields retained while the host moves to the owner seam. */
  projectDir?: string;
  readCurrentState?: () => WorkflowState | null;
  bus?: EventBus;
  setActiveSessionId?: (id: string) => void;
  getRecoveryProjection?: () => BriefRecoveryProjectionV1 | null;
  getRecoveryResult?: () => RecoveryResultV1 | null;
};

export type RpcBriefReviewDraftDispatchInput = Readonly<{
  sessionId: string;
  tasksFilePath: string;
}>;

export type RpcBriefReviewDraftControllerResult =
  | Readonly<{
      ok: true;
      projection: BriefRecoveryProjectionV1;
      result: RecoveryResultV1;
      taskCount?: number;
      qualityPassed?: boolean;
      qualityScore?: number;
      issueCount?: number;
    }>
  | Readonly<{
      ok: false;
      message: string;
      projection?: BriefRecoveryProjectionV1 | null;
      result?: RecoveryResultV1 | null;
    }>;

export type RpcBriefReviewDraftResult =
  | (Extract<BriefReviewDraftSaveResult, { ok: true }> & {
      projection: BriefRecoveryProjectionV1;
      result: RecoveryResultV1;
    })
  | (Extract<BriefReviewDraftSaveResult, { ok: false }> & {
      projection?: BriefRecoveryProjectionV1 | null;
      result?: RecoveryResultV1 | null;
    });

function recoveryFromDeps(deps: RpcBriefReviewDraftDeps): {
  projection: BriefRecoveryProjectionV1 | null;
  result: RecoveryResultV1 | null;
} {
  const result = deps.getRecoveryResult?.() ?? null;
  return {
    projection: deps.getRecoveryProjection?.() ?? result?.projection ?? null,
    result,
  };
}

function controllerUnavailable(
  deps: RpcBriefReviewDraftDeps,
): Extract<RpcBriefReviewDraftResult, { ok: false }> {
  const recovery = recoveryFromDeps(deps);
  return {
    ok: false,
    message: 'Task Brief draft save requires the active recovery controller.',
    ...(recovery.projection !== null && { projection: recovery.projection }),
    ...(recovery.result !== null && { result: recovery.result }),
  };
}

function controllerResultToDraftResult(
  outcome: RpcBriefReviewDraftControllerResult,
): RpcBriefReviewDraftResult {
  if (!outcome.ok) {
    return {
      ok: false,
      message: boundedDraftSaveError(outcome.message),
      ...(outcome.projection !== undefined && { projection: outcome.projection }),
      ...(outcome.result !== undefined && { result: outcome.result }),
    };
  }

  const issueCount = outcome.issueCount ?? outcome.projection.matchingReport?.issues.length ?? 0;
  return {
    ok: true,
    qualityPassed: outcome.qualityPassed ?? outcome.projection.status === 'ready',
    qualityScore: outcome.qualityScore ?? (outcome.projection.status === 'ready' ? 1 : 0),
    issueCount,
    taskCount: outcome.taskCount ?? 0,
    projection: outcome.projection,
    result: outcome.result,
  };
}

export function createRpcBriefReviewDraftSaver(
  deps: RpcBriefReviewDraftDeps,
): (tasksFilePath: string) => Promise<RpcBriefReviewDraftResult> {
  return async (tasksFilePath: string): Promise<RpcBriefReviewDraftResult> => {
    const id = deps.resolveSessionId();
    if (!id) {
      return {
        ok: false,
        message: 'No active session is available for Task Brief draft save.',
      };
    }

    const dispatch = deps.dispatchBriefReview;
    if (dispatch === undefined) return controllerUnavailable(deps);

    try {
      const result = await dispatch({ sessionId: id, tasksFilePath });
      return controllerResultToDraftResult(result);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const recovery = recoveryFromDeps(deps);
      return {
        ok: false,
        message: boundedDraftSaveError(message),
        ...(recovery.projection !== null && { projection: recovery.projection }),
        ...(recovery.result !== null && { result: recovery.result }),
      };
    }
  };
}
