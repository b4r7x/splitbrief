import type { IpcPromptRequest, IpcPromptResponse } from '../../engine/ipc/protocol.js';
import type { RecoveryAction } from '../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../core/schemas/recovery.js';
import { resolveSessionFilePath } from '../../core/sessions/confinement.js';
import { openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { openCostApprovalPrompt } from '../../stores/cost-approval/prompt.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { BRIEFS_REVIEW_HINT, REVIEW_HINT } from './review-parser.js';
import {
  formatUserEditConflictPrompt,
  parseUserEditConflictAnswer,
} from './user-edit-conflict-prompt.js';
import {
  formatMiddotList,
  formatRecoveryActionLines,
  getRecoveryPromptActions,
  parseRecoveryActionAnswer,
} from './recovery-prompt.js';
import { formatTaskReviewPrompt, parseTaskReviewAnswer } from './task-review-prompt.js';
import { assertNever } from '../../utils/type-guards.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

type IpcRecoveryIssue = Extract<IpcPromptRequest, { kind: 'recovery_needed' }>['issue'];

function ipcIssueAsRecoveryIssue(issue: IpcRecoveryIssue): RecoveryIssue {
  return {
    id: issue.id,
    reason: issue.reason,
    phase: issue.phase,
    status: 'awaiting-user',
    message: '',
    files: issue.files,
    affectedTaskIds: issue.affectedTaskIds,
    details: [],
    availableActions: issue.availableActions,
    recommendedAction: issue.recommendedAction,
    createdAt: '',
    ...(issue.taskId !== undefined && { taskId: issue.taskId }),
    ...(issue.taskTitle !== undefined && { taskTitle: issue.taskTitle }),
    ...(issue.selectedImplementerProfile !== undefined && {
      selectedImplementerProfile: issue.selectedImplementerProfile,
    }),
  };
}

export function formatIpcRecoveryPrompt(issue: IpcRecoveryIssue): string {
  const recoveryIssue = ipcIssueAsRecoveryIssue(issue);
  const actions = getRecoveryPromptActions(recoveryIssue);
  const context = { reason: issue.reason };
  const recommended = actions.includes(issue.recommendedAction)
    ? issue.recommendedAction
    : undefined;
  const lines = [
    `recovery needed · ${issue.reason}`,
    '',
    ...formatIpcRecoverySubjectLines(issue),
    '',
    ...formatRecoveryActionLines(actions, context, recommended),
  ];
  return lines
    .filter((line, index) => line.length > 0 || lines[index - 1] !== '')
    .join('\n')
    .trimEnd();
}

interface IpcPromptDispatcherOptions {
  sessionDirPath?: string | undefined;
}

function formatIpcRecoverySubjectLines(issue: IpcRecoveryIssue): string[] {
  const lines: string[] = [];
  if (issue.taskId !== undefined && issue.taskTitle !== undefined) {
    lines.push(`task ${issue.taskId} · ${issue.taskTitle}`);
  } else if (issue.taskId !== undefined) {
    lines.push(`task ${issue.taskId}`);
  }
  if (issue.files.length > 0) lines.push(`files ${formatMiddotList(issue.files, 3)}`);
  if (issue.affectedTaskIds.length > 0) {
    lines.push(`affected ${formatMiddotList(issue.affectedTaskIds, 3)}`);
  }
  const worker = issue.workerProfile ?? issue.selectedImplementerProfile;
  if (worker !== undefined) lines.push(`worker ${worker}`);
  return lines;
}

export function parseIpcRecoveryAction(
  input: string,
  issue: IpcRecoveryIssue,
): RecoveryAction | null {
  return parseRecoveryActionAnswer(input, ipcIssueAsRecoveryIssue(issue));
}

export function createIpcPromptDispatcher(
  inputMode: UseInputModeResult,
  opts: IpcPromptDispatcherOptions = {},
): (request: IpcPromptRequest) => Promise<IpcPromptResponse> {
  return async (request: IpcPromptRequest): Promise<IpcPromptResponse> => {
    if (request.kind === 'approval_needed') {
      const filePath = resolveApprovalReviewPath(request.filePath, opts.sessionDirPath);
      if (filePath === null) return { kind: 'approval_needed', approved: false };

      const reviewOwner = reviewStore.setReviewFile(filePath);
      const hint = request.approvalType === 'briefs' ? BRIEFS_REVIEW_HINT : REVIEW_HINT;
      const result = await inputMode.setReviewMode(hint);
      reviewStore.clearReviewIfOwner(reviewOwner);
      if (result.approved) {
        return { kind: 'approval_needed', approved: true };
      }
      if (result.action === 'edit') {
        return {
          kind: 'approval_needed',
          approved: false,
          action: result.action,
          ...(result.comment !== undefined && { comment: result.comment }),
        };
      }
      if (result.action === 'revise') {
        return {
          kind: 'approval_needed',
          approved: false,
          action: result.action,
          comment: result.comment,
          ...(result.taskIds !== undefined && { taskIds: result.taskIds }),
        };
      }
      return { kind: 'approval_needed', approved: false };
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
      const approved = await openCostApprovalPrompt(request.prediction);
      return { kind: 'cost_approval', approved };
    }

    if (request.kind === 'task_review') {
      const prompt = formatTaskReviewPrompt(request.request);
      while (true) {
        const answer = await inputMode.setQuestionMode(prompt);
        const response = parseTaskReviewAnswer(answer, request.request.availableCommands);
        if (response !== null) return { kind: 'task_review', response };
        feedbackStore.setError(
          `Unrecognized task review command. Use: ${request.request.availableCommands.join(', ')}.`,
        );
      }
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
