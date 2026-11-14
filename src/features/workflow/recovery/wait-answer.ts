import { formatSubmissionFailure } from '../../../components/composer/home-hint.js';
import { prepareDraftSubmission } from '../../../core/composer/submission.js';
import { recoveryActionLabel } from '../../../core/recovery/action-label.js';
import { stepReadsNoWords, leavesWordsUnread } from '../../../core/recovery/typed-words.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { resumeStep } from '../../../core/sessions/run/status.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { plannerSupportsImages } from '../../../engine/providers/capabilities.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { configStore } from '../../../stores/project/config.js';
import { composerDraftStore } from '../../../stores/ui/composer-draft.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { updateWaitingHalt } from '../../../stores/workflow/actions/hydrate.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import type { QuestionAnswer } from '../hooks/use-input-mode.js';
import { nextEntryReviewNone } from '../run-loop/seat-config.js';
import {
  correctionActionFor,
  NO_CORRECTION_MESSAGE,
  parseRecoveryActionAnswer,
} from './actions.js';
import { applyAction } from './apply-action.js';
import { formatRecoveryPrompt } from './prompt-text.js';
import type { NextPass, PendingRecoveryResult, RecoveryDriverState } from './types.js';

/**
 * REVIEW None at the halt is the value the next pass runs on, so a move of REVIEW while the
 * panel waits changes what the answer does.
 */
export function readNextPass(entry: RecoveryDriverState['entry'], issue: RecoveryIssue): NextPass {
  const reviewNone = nextEntryReviewNone(entry);
  const at = resumeStep(entry.state, reviewNone);
  const stepReadsNone = stepReadsNoWords(at, reviewNone);
  return {
    reviewNone,
    at,
    stepReadsNone,
    correctionAction: correctionActionFor(issue, stepReadsNone),
  };
}

/**
 * `revise` carries the operator's words to the planner, so the panel asks for them before it
 * applies: an empty answer resolves the halt with no note.
 */
export function noteQuestion(
  driver: RecoveryDriverState,
  action: RecoveryAction,
): string | undefined {
  const { issue } = driver;
  if (action === 'accept-as-is' && issue.reason === 'review-input-too-large') {
    return 'Why skip the review? (enter records none)';
  }
  if (action !== 'revise') return undefined;
  if (issue.reason !== 'review-failed')
    return 'What should the planner change? (enter sends no note)';
  return driver.nextPass.reviewNone
    ? undefined
    : "What should the fix change? (enter sends the review's findings alone)";
}

/**
 * One wait serves the panel and its note question. While a question waits, the next pass and the
 * view follow a move of REVIEW: once answered, this state is stale. A move that changes the
 * question ends it with no answer. The file is read when the answer comes, so a hand edit counts
 * too; End run reads none. An answer that the file or a move leaves with no question is not
 * taken, and its words go back to the composer.
 */
async function waitForAnswer(
  driver: RecoveryDriverState,
  question: string,
  stillAsked: () => boolean,
): Promise<QuestionAnswer | undefined> {
  const { state, issue, inputMode } = driver;
  const moved = Promise.withResolvers<undefined>();
  const follow = (): void => {
    driver.nextPass = readNextPass(driver.entry, issue);
    updateWaitingHalt(state, driver.nextPass.reviewNone);
    if (!stillAsked()) moved.resolve(undefined);
  };
  follow();
  const stopFollowing = configStore.subscribe(follow);
  try {
    const answer = await Promise.race([inputMode.setQuestionMode(question), moved.promise]);
    if (answer === undefined) return undefined;
    const refuse = (): undefined => {
      if (answer.row !== true && answer.message.text.trim() !== '') {
        composerDraftStore.requestPrepend(answer.document);
      }
      return undefined;
    };
    const endsRun =
      answer.row === true &&
      parseRecoveryActionAnswer(answer.message.displayText, issue) === 'end-run';
    if (!endsRun) {
      try {
        configStore.reloadIfChanged();
      } catch (err) {
        feedbackStore.setError(toErrorMessage(err));
        return refuse();
      }
    }
    return stillAsked() ? answer : refuse();
  } finally {
    stopFollowing();
  }
}

/** Asks the panel until an answer applies an action or the run stops. */
export async function askForAction(driver: RecoveryDriverState): Promise<PendingRecoveryResult> {
  const { issue, state, controller, abortedRef, prepared, reentryCorrection } = driver;
  const { projectDir } = prepared.session.ref;
  while (true) {
    recoveryNoticeStore.ask(true);
    const waited = await waitForAnswer(driver, formatRecoveryPrompt(issue), () => true);
    recoveryNoticeStore.ask(false);
    if (controller.signal.aborted || abortedRef.current) {
      return { shouldRun: false, state };
    }
    if (waited === undefined) continue;
    const { message: answer, document, row } = waited;
    const { reviewNone, stepReadsNone, correctionAction } = driver.nextPass;
    let action = parseRecoveryActionAnswer(answer.displayText, issue);
    // Only a row picks an action. Words from the composer are the correction, or the halt
    // refuses them. The correction action's own word runs it with no steer.
    if (row !== true && action !== correctionAction) action = null;
    let correction: UserMessageInput | undefined;
    if (action === null && answer.text.trim() !== '') {
      if (correctionAction === undefined) {
        feedbackStore.setMessage(NO_CORRECTION_MESSAGE);
        composerDraftStore.requestPrepend(document);
        continue;
      }
      action = correctionAction;
      correction = answer;
    }
    if (action === null) {
      feedbackStore.setError('Unknown recovery action.');
      continue;
    }
    // Words typed beside the panel are the note of the action that takes one.
    const draft = composerLiveStore.get();
    if (!draft.empty && leavesWordsUnread(issue.reason, action, stepReadsNone)) {
      feedbackStore.setMessage(
        `Cannot send words with ${recoveryActionLabel(action, { reason: issue.reason, reviewNone })}. Clear them.`,
      );
      continue;
    }
    if (correction === undefined && action === correctionAction && !draft.empty) {
      const submission = prepareDraftSubmission(draft.document, {
        projectDir,
        supportsImages: plannerSupportsImages(prepared.config, modelCacheStore),
      });
      if (!submission.ok) {
        feedbackStore.setError(formatSubmissionFailure(submission));
        composerDraftStore.requestDocument(draft.document);
        continue;
      }
      correction = submission.message;
      attachmentsStore.replacePendingImages(correction.images);
      composerDraftStore.request('');
    }
    if (correction === undefined && action === correctionAction) correction = reentryCorrection;
    let comment = correction;
    const question = comment === undefined ? noteQuestion(driver, action) : undefined;
    if (question !== undefined) {
      const note = await waitForAnswer(
        driver,
        question,
        () => noteQuestion(driver, action) === question,
      );
      if (controller.signal.aborted || abortedRef.current) {
        return { shouldRun: false, state };
      }
      if (note === undefined) continue;
      comment = note.message;
    }
    const applied = await applyAction(driver, action, comment, correction ?? reentryCorrection);
    if (applied !== null) return applied;
  }
}
