import { isQueuePhase } from '../../../core/phases/roles.js';
import { messageSeat } from '../../../core/queue/state.js';
import { selectBuildMessageBrief } from '../../../core/run-view/briefs.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { approvalPromptStore } from '../../../stores/prompts/approval.js';
import { composerDraftStore } from '../../../stores/ui/composer-draft.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { reviewKeysStore } from '../../../stores/ui/review-keys.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import {
  selectScheduledReview,
  operationsStore,
} from '../../../stores/workflow/operations/state.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { stopInProgress, stopStore } from '../../../stores/workflow/stop.js';
import { spawnEditorProcess } from '../external-editor/spawn.js';
import { requestEnqueue } from '../run-requests/registry.js';
import { type UseInputModeResult, answerWaitingQuestion } from '../hooks/use-input-mode.js';
import { queueCopy } from '../queue-copy.js';
import {
  reviewOpeningPromptMessage,
  parseReviewCommand,
  REVIEW_UNKNOWN_COMMAND_MESSAGE,
  reviewCommandToApprovalReviewResult,
} from './commands.js';
import { openReviewFileExternally } from './external-edit.js';
import { reviewEditPath, openReviewEditor } from './plan-editor.js';

// Words typed in a review phase belong to the confirmation that waits there, not to a seat.
const CONFIRM_WAITING_MESSAGE = 'Confirm or deny the prompt first. Tab back to the actions.';

export interface ReviewInputHandler {
  handleInput: (message: UserMessageInput) => Promise<void>;
}

/**
 * The two effects live review input spends outside the stores: the editor process and the
 * planner queue. Supplied whole or not at all — a caller that hands over one function owns
 * both, so no surface can start a real editor while it believes it is running on fixtures.
 */
export interface ReviewInputEffects {
  openExternalEditor: (inputMode: UseInputModeResult, baseline?: string) => Promise<void>;
  enqueue: typeof requestEnqueue;
}

const productionReviewInputEffects: ReviewInputEffects = {
  openExternalEditor: (inputMode, baseline) =>
    openReviewFileExternally(inputMode, spawnEditorProcess, baseline),
  enqueue: requestEnqueue,
};

export function createReviewInputHandler(
  inputMode: UseInputModeResult,
  effects: ReviewInputEffects = productionReviewInputEffects,
): ReviewInputHandler {
  const handleInput = async (message: UserMessageInput) => {
    const text = message.displayText;
    if (inputMode.mode === 'normal') {
      const lifecycle = lifecycleStore.get();
      // Dead-zone window: the interrupt landed but the continuation prompt has not
      // parked yet, so typed text can neither steer nor queue — tell the user why.
      if (lifecycle.status === 'interrupted' && !lifecycle.interruptParked) {
        if (text.trim()) {
          feedbackStore.setMessage('Interrupt pending — stopping at the next step boundary.');
        }
        return;
      }
      const { phase, briefs, reviewNone } = runViewStore.get();
      if (isQueuePhase(phase)) {
        const trimmed = text.trim();
        if (trimmed) {
          const document = composerLiveStore.get().document;
          const buildBrief = selectBuildMessageBrief(briefs);
          const seat = messageSeat(
            phase,
            selectScheduledReview(operationsStore.get()),
            reviewNone,
            buildBrief !== null,
          );
          const taskId = buildBrief?.id;
          const steerable = lifecycle.steerableCall?.seat === seat;
          const result = await effects.enqueue(message, phase);
          if (!result) {
            composerDraftStore.requestPrepend(document);
            feedbackStore.setMessage('Cannot queue message: no active workflow.');
          } else if (result.status === 'rejected') {
            // The submission was refused: it comes back in front of whatever the composer holds
            // now, so a rejection loses neither what was sent nor what was typed since.
            composerDraftStore.requestPrepend(document);
            if (result.reason === 'failed') feedbackStore.setError(result.message);
            else feedbackStore.setMessage(result.message);
          } else if (seat !== null) {
            feedbackStore.setMessage(
              queueCopy({
                seat,
                taskId,
                steerable,
                stopping: stopInProgress(stopStore.get()),
              }).feedback,
            );
          }
        }
      } else if (text.trim()) {
        // No seat takes queued words in this phase, so the words go back to the composer.
        composerDraftStore.requestPrepend(composerLiveStore.get().document);
        if (
          phase === 'reviewing-spec' ||
          phase === 'reviewing-plan' ||
          phase === 'reviewing-briefs'
        ) {
          feedbackStore.setMessage(
            approvalPromptStore.get().status === 'pending'
              ? CONFIRM_WAITING_MESSAGE
              : reviewOpeningPromptMessage(),
          );
        }
      }
      return;
    }

    if (inputMode.mode === 'review') {
      // After Request changes the whole draft is the change request, whatever word it opens with.
      if (reviewKeysStore.get().requested) {
        inputMode.resolve({ approved: false, action: 'revise', message });
        return;
      }
      const parsed = parseReviewCommand(text);
      if (!parsed) {
        // Any other text at the plan card is a correction the planning session answers.
        const correction = text.trim();
        if (correction !== '' && reviewEditPath() !== null) {
          inputMode.resolve({ approved: false, action: 'revise', message });
          return;
        }
        feedbackStore.setMessage(REVIEW_UNKNOWN_COMMAND_MESSAGE);
        return;
      }
      if (parsed.kind === 'brief-review-command') {
        if (parsed.command.action === 'revise') {
          const parsedComment = parsed.command.comment;
          const correctionMessage: UserMessageInput = {
            ...message,
            displayText: parsedComment,
            text: parsedComment + message.text.slice(message.displayText.length),
          };
          inputMode.resolve({ approved: false, action: 'revise', message: correctionMessage });
          return;
        }
        inputMode.resolve(reviewCommandToApprovalReviewResult(parsed.command));
        return;
      }
      if (parsed.kind === 'comment-draft') {
        reviewKeysStore.requestComment();
        return;
      }
      if (parsed.kind === 'open-editor') await openReviewEditor();
      return;
    }

    if (inputMode.mode === 'question') {
      answerWaitingQuestion(inputMode, { message, document: composerLiveStore.get().document });
    }
  };

  return { handleInput };
}
