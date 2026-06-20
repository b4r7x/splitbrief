import type { IpcPromptRequest, IpcPromptResponse } from '../../engine/ipc/protocol.js';
import type { RecoveryAction } from '../../core/schemas/enums.js';
import { resolveSessionFilePath } from '../../core/sessions/confinement.js';
import { formatTruncatedList } from '../../core/formatting.js';
import { openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { BRIEFS_REVIEW_HINT, REVIEW_HINT } from './review-parser.js';
import {
  formatUserEditConflictPrompt,
  parseUserEditConflictAnswer,
} from './user-edit-conflict-prompt.js';
import {
  ACTION_ALIASES,
  formatRecoveryActionChoice,
  formatRecoveryActionText,
} from './recovery-prompt.js';
import { assertNever } from '../../utils/type-guards.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

type IpcRecoveryIssue = Extract<IpcPromptRequest, { kind: 'recovery_needed' }>['issue'];

interface IpcPromptDispatcherOptions {
  sessionDirPath?: string | undefined;
}

export function formatIpcRecoveryPrompt(issue: IpcRecoveryIssue): string {
  const context = { reason: issue.reason };
  const lines = [
    `Recovery needed: ${issue.reason}`,
    ...formatIpcRecoverySubjectLines(issue),
    `Recommended: ${formatRecoveryActionText(issue.recommendedAction, context)}`,
    '',
    ...issue.availableActions.map((action) => formatRecoveryActionChoice(action, context)),
  ];
  return lines.join('\n').trimEnd();
}

function formatIpcRecoverySubjectLines(issue: IpcRecoveryIssue): string[] {
  const lines: string[] = [];
  if (issue.taskId !== undefined && issue.taskTitle !== undefined) {
    lines.push(`Task: ${issue.taskId} - ${issue.taskTitle}`);
  } else if (issue.taskId !== undefined) {
    lines.push(`Task: ${issue.taskId}`);
  }
  if (issue.files.length > 0) lines.push(`Files: ${formatTruncatedList(issue.files, 3)}`);
  if (issue.affectedTaskIds.length > 0) {
    lines.push(`Affected tasks: ${formatTruncatedList(issue.affectedTaskIds, 3)}`);
  }
  const worker = issue.workerProfile ?? issue.selectedImplementerProfile;
  if (worker !== undefined) lines.push(`Worker: ${worker}`);
  return lines;
}

export function parseIpcRecoveryAction(
  input: string,
  issue: IpcRecoveryIssue,
): RecoveryAction | null {
  const available = new Set(issue.availableActions);
  const isWhitespaceOnly = input.length > 0 && input.trim().length === 0;
  if (isWhitespaceOnly && available.has('pause-run')) return 'pause-run';

  const normalized = input.trim().toLowerCase();
  for (const action of issue.availableActions) {
    if (ACTION_ALIASES[action].includes(normalized)) return action;
  }
  return null;
}

export function createIpcPromptDispatcher(
  inputMode: UseInputModeResult,
  opts: IpcPromptDispatcherOptions = {},
): (request: IpcPromptRequest) => Promise<IpcPromptResponse> {
  return async (request: IpcPromptRequest): Promise<IpcPromptResponse> => {
    if (request.kind === 'approval_needed') {
      const filePath = resolveApprovalReviewPath(request.filePath, opts.sessionDirPath);
      if (filePath === null) return { kind: 'approval_needed', approved: false };

      reviewStore.setReviewFile(filePath);
      const hint = request.approvalType === 'briefs' ? BRIEFS_REVIEW_HINT : REVIEW_HINT;
      const result = await inputMode.setReviewMode(hint);
      reviewStore.clearReview();
      return {
        kind: 'approval_needed',
        approved: result.approved,
        ...(result.comment !== undefined && { comment: result.comment }),
        ...(result.action !== undefined && { action: result.action }),
      };
    }

    if (request.kind === 'user_edit_conflict') {
      const answer = await inputMode.setQuestionMode(
        formatUserEditConflictPrompt(request.conflict),
      );
      return {
        kind: 'user_edit_conflict',
        selectedAction: parseUserEditConflictAnswer(answer, request.conflict.availableActions),
      };
    }

    if (request.kind === 'question_asked') {
      const answer = await inputMode.setQuestionMode(
        `Question ${request.num}/${request.total}: ${request.question.text}`,
      );
      return { kind: 'question_asked', answer };
    }

    if (request.kind === 'continuation_needed') {
      const text = await inputMode.setQuestionMode(
        'Task interrupted. Enter instructions to continue (or press Enter to retry):',
      );
      return { kind: 'continuation_needed', text };
    }

    if (request.kind === 'cost_approval') {
      const result = await inputMode.setReviewMode('Cost estimate ready. approve / reject');
      return { kind: 'cost_approval', approved: result.approved };
    }

    if (request.kind === 'task_review') {
      const result = await inputMode.setReviewMode(
        `Review task ${request.request.taskId}: continue / abort`,
      );
      return { kind: 'task_review', response: { action: result.approved ? 'continue' : 'abort' } };
    }

    if (request.kind === 'tiered_approval') {
      const response = await openApprovalPrompt(request.request);
      return { kind: 'tiered_approval', response };
    }

    if (request.kind === 'recovery_needed') {
      while (true) {
        const answer = await inputMode.setQuestionMode(formatIpcRecoveryPrompt(request.issue));
        const action = parseIpcRecoveryAction(answer, request.issue);
        if (action !== null) return { kind: 'recovery_needed', action };
        feedbackStore.setError('Unknown recovery action.');
      }
    }

    return assertNever(request);
  };
}

function resolveApprovalReviewPath(
  filePath: string,
  sessionDirPath: string | undefined,
): string | null {
  if (sessionDirPath === undefined) {
    feedbackStore.setError('IPC approval prompt missing session context.');
    return null;
  }

  try {
    return resolveSessionFilePath(filePath, sessionDirPath);
  } catch (err) {
    feedbackStore.setError(`Rejected IPC approval path: ${toErrorMessage(err)}`);
    return null;
  }
}
