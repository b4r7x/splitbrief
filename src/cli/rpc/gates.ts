import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import {
  allowedBriefReviewCommandsForPrompt,
  briefReviewCommandDisposition,
  isBriefReviewCommandAllowedForPrompt,
  type BriefReviewCommand,
  type BriefReviewCommandAction,
  type BriefReviewPromptKind,
} from '../../core/schemas/brief-review-command.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { RpcCommand } from './types.js';

type ApprovalGateCommon = {
  confirmationPhrase?: string | undefined;
  confirmationReason?: string | undefined;
};

export type ApprovalGateResult =
  | (ApprovalGateCommon & {
      approved: true;
      action?: undefined;
      comment?: string | undefined;
    })
  | (ApprovalGateCommon & {
      approved: false;
      action: 'edit';
      comment?: string | undefined;
    })
  | (ApprovalGateCommon & {
      approved: false;
      action: 'revise';
      comment: string;
      taskIds?: TaskId[] | undefined;
    })
  | (ApprovalGateCommon & {
      approved: false;
      action?: undefined;
      comment?: string | undefined;
    });

export type ApprovalGatePrompt = {
  promptId: string;
  approvalType?: BriefReviewPromptKind | undefined;
  allowedCommands: readonly BriefReviewCommandAction[];
};

type ApprovalGateWaitOptions = {
  approvalType?: BriefReviewPromptKind | undefined;
  onSaveDraft?: BriefReviewDraftSaveHandler | undefined;
};

export type BriefReviewDraftSaveResult =
  | {
      ok: true;
      qualityPassed: boolean;
      qualityScore: number;
      issueCount: number;
      taskCount: number;
    }
  | { ok: false; message: string };

export type BriefReviewDraftSaveHandler = () =>
  | BriefReviewDraftSaveResult
  | Promise<BriefReviewDraftSaveResult>;

export type BriefReviewGateResult =
  | { status: 'settled'; prompt: ApprovalGatePrompt }
  | { status: 'status'; prompt: ApprovalGatePrompt | null }
  | {
      status: 'saved';
      prompt: ApprovalGatePrompt;
      draft: Extract<BriefReviewDraftSaveResult, { ok: true }>;
    }
  | { status: 'rejected'; prompt: ApprovalGatePrompt | null; message: string };

export function validateConfirmApprovalFields(fields: {
  confirmationPhrase?: string | undefined;
  confirmationReason?: string | undefined;
  comment?: string | undefined;
}): { ok: true; reason: string } | { ok: false } {
  const reason = fields.confirmationReason?.trim() || fields.comment?.trim();
  if (fields.confirmationPhrase === CONFIRM_PHRASE && reason) {
    return { ok: true, reason };
  }
  return { ok: false };
}

export function createGate<T>() {
  let resolveFn: ((value: T) => void) | null = null;
  let rejectFn: ((reason: Error) => void) | null = null;

  return {
    wait(): Promise<T> {
      return new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    },
    resolve(value: T): boolean {
      if (!resolveFn) return false;
      resolveFn(value);
      resolveFn = null;
      rejectFn = null;
      return true;
    },
    reject(reason: Error): boolean {
      if (!rejectFn) return false;
      rejectFn(reason);
      resolveFn = null;
      rejectFn = null;
      return true;
    },
    isPending(): boolean {
      return resolveFn !== null;
    },
  };
}

export function createApprovalGate() {
  const gate = createGate<ApprovalGateResult>();
  let nextPromptId = 1;
  let currentPrompt: ApprovalGatePrompt | null = null;
  let currentSaveDraft: BriefReviewDraftSaveHandler | null = null;

  function clearPrompt(): void {
    currentPrompt = null;
    currentSaveDraft = null;
  }

  function wait(options: ApprovalGateWaitOptions = {}): Promise<ApprovalGateResult> {
    currentPrompt = {
      promptId: `approval-${nextPromptId++}`,
      approvalType: options.approvalType,
      allowedCommands:
        options.approvalType === undefined
          ? []
          : allowedBriefReviewCommandsForPrompt(options.approvalType),
    };
    currentSaveDraft = options.onSaveDraft ?? null;
    return gate.wait().finally(clearPrompt);
  }

  function reject(reason: Error): boolean {
    const rejected = gate.reject(reason);
    clearPrompt();
    return rejected;
  }

  function resolve(value: ApprovalGateResult): boolean {
    const resolved = gate.resolve(value);
    clearPrompt();
    return resolved;
  }

  async function handleBriefReview(
    command: BriefReviewCommand,
    promptId?: string | undefined,
  ): Promise<BriefReviewGateResult> {
    const prompt = currentPrompt;
    if (command.action === 'status') {
      if (promptId !== undefined && prompt !== null && promptId !== prompt.promptId) {
        return {
          status: 'rejected',
          prompt,
          message: `Task Brief review prompt mismatch: expected ${prompt.promptId}, got ${promptId}.`,
        };
      }
      return { status: 'status', prompt };
    }

    if (!gate.isPending() || prompt === null) {
      return {
        status: 'rejected',
        prompt: null,
        message: 'No pending Task Brief review prompt.',
      };
    }
    if (promptId !== undefined && promptId !== prompt.promptId) {
      return {
        status: 'rejected',
        prompt,
        message: `Task Brief review prompt mismatch: expected ${prompt.promptId}, got ${promptId}.`,
      };
    }
    if (prompt.approvalType !== 'briefs') {
      return {
        status: 'rejected',
        prompt,
        message: 'Current approval prompt does not accept Task Brief review commands.',
      };
    }
    if (!isBriefReviewCommandAllowedForPrompt(command, prompt.approvalType)) {
      return {
        status: 'rejected',
        prompt,
        message: `Task Brief review command is not allowed for this prompt: ${command.action}.`,
      };
    }

    const disposition = briefReviewCommandDisposition(command);
    if (disposition.kind === 'save-draft') {
      if (currentSaveDraft === null) {
        return {
          status: 'rejected',
          prompt,
          message: 'Task Brief save_draft is not available for this prompt.',
        };
      }
      const draft = await currentSaveDraft();
      if (!draft.ok) {
        return { status: 'rejected', prompt, message: draft.message };
      }
      return { status: 'saved', prompt, draft };
    }

    if (disposition.kind === 'status') {
      return {
        status: 'rejected',
        prompt,
        message: 'Task Brief review command does not resolve the prompt.',
      };
    }

    if (!resolve(disposition.result)) {
      return {
        status: 'rejected',
        prompt,
        message: 'Task Brief review prompt was already resolved.',
      };
    }
    return { status: 'settled', prompt };
  }

  return {
    wait,
    reject,
    handle(cmd: RpcCommand): boolean {
      if (!gate.isPending()) return false;
      if (cmd.type === 'approve') {
        return resolve({
          approved: true,
          confirmationPhrase: cmd.confirmationPhrase,
          confirmationReason: cmd.confirmationReason,
        });
      }
      if (cmd.type === 'reject') {
        return resolve({ approved: false });
      }
      if (cmd.type === 'regenerate') {
        return resolve({ approved: false, action: 'revise', comment: cmd.comment });
      }
      return false;
    },
    handleBriefReview,
    isPending: gate.isPending,
    pendingPrompt: () => currentPrompt,
  };
}
