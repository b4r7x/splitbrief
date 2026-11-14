import { formatSubmissionFailure } from '../../../components/composer/home-hint.js';
import { prepareDraftSubmission } from '../../../core/composer/submission.js';
import { sameSeatCandidate } from '../../../core/crew/identity.js';
import { recoveryActionLabel } from '../../../core/recovery/action-label.js';
import { stepReadsNoWords, leavesWordsUnread } from '../../../core/recovery/typed-words.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import { resumeStep, deriveRunStatus } from '../../../core/sessions/run/status.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { publishRecoveryPrompted } from '../../../engine/orchestrator/events.js';
import { publishRetainedWorkspaceNotice } from '../../../engine/orchestrator/isolation/retention.js';
import {
  type ApplyRecoveryActionResult,
  applyRecoveryAction,
  applyDecidedRecovery,
} from '../../../engine/orchestrator/recovery/actions.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { filesStillOnDiskSuffix } from '../../../engine/orchestrator/run/close.js';
import { plannerSupportsImages } from '../../../engine/providers/capabilities.js';
import { parsePreparedConfig } from '../../../engine/runners/prepared-execution.js';
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
import { runResumePolicy } from '../resume/policy.js';
import { nextEntryReviewNone, nextEntryConfig } from '../run-loop/seat-config.js';
import {
  correctionActionFor,
  NO_CORRECTION_MESSAGE,
  parseRecoveryActionAnswer,
} from './actions.js';
import { formatRecoveryPrompt } from './prompt-text.js';
import { seatIn, pickSwappedSeat } from './seat-swap-pick.js';
import type {
  RecoveryDriverOptions,
  PromptPendingRecoveryArgs,
  PendingRecoveryResult,
} from './types.js';

/**
 * The one surface that resolves a halt in the TUI: it renders the pending
 * recovery as a question, parses the operator's answer into a recovery action
 * and applies it. A blocked action stays in this loop so the same halt remains
 * actionable; a successful action either resumes on the returned state or stops.
 *
 * `switch-seat` is the exception it does not apply itself — taking that offer
 * re-prepares the session on another tool, and that preparation is the run
 * loop's own re-entry, so the choice travels back as `switchSeat` and the halt
 * stays pending until the loop resolves it (`applyOfferedSeatSwap`).
 *
 * The halt is read once from the passed state and reused for the prompt text, the
 * answer parse and the apply: a session has one running process, and that process
 * is parked on this prompt, so nothing else can resolve or replace the halt while
 * the operator is answering.
 */
export function createRecoveryDriver(
  opts: RecoveryDriverOptions,
): (args: PromptPendingRecoveryArgs) => Promise<PendingRecoveryResult> {
  const {
    prepared,
    configOfRun,
    inputMode,
    abortedRef,
    retentionNoticeHandled,
    sink,
    setInlineResume,
  } = opts;
  const { ref } = prepared.session;
  const { projectDir, sessionId } = ref;
  const config = prepared.config;

  async function promptRecovery({
    state,
    controller,
    republishPrompt,
    correction: reentryCorrection,
  }: PromptPendingRecoveryArgs): Promise<PendingRecoveryResult> {
    const issue = state.pendingRecovery;
    if (issue === undefined) return { shouldRun: true, state };
    const entry = { configOfRun, prepared: config, state };
    // REVIEW None at the halt is the value the next pass runs on, so a move of REVIEW while the
    // panel waits changes what the answer does.
    const readNextPass = () => {
      const reviewNone = nextEntryReviewNone(entry);
      const at = resumeStep(state, reviewNone);
      const stepReadsNone = stepReadsNoWords(at, reviewNone);
      return {
        reviewNone,
        at,
        stepReadsNone,
        correctionAction: correctionActionFor(issue, stepReadsNone),
      };
    };
    let nextPass = readNextPass();

    // The halt's declaration is its automatic intent: the declared fallback is taken
    // at once, with no panel question and no picker, and the run loop applies it
    // through `applyOfferedSeatSwap` like any other switch. An unadmitted swap leaves
    // the halt pending; the loop spends the intent, so the next entry asks the panel
    // and the operator picks the seat by hand.
    const auto = issue.switchSeat?.auto;
    if (auto !== undefined) {
      feedbackStore.reset();
      return {
        shouldRun: true,
        state,
        switchSeat: { candidate: auto.candidate, policy: runResumePolicy(prepared.runtime) },
      };
    }

    const bus = createRecoveryBus({ projectDir, sessionId, sink });

    // `revise` carries the operator's words to the planner, so the panel asks for
    // them before it applies: an empty answer resolves the halt with no note.
    const noteQuestion = (action: RecoveryAction): string | undefined => {
      if (action === 'accept-as-is' && issue.reason === 'review-input-too-large') {
        return 'Why skip the review? (enter records none)';
      }
      if (action !== 'revise') return undefined;
      if (issue.reason !== 'review-failed')
        return 'What should the planner change? (enter sends no note)';
      return nextPass.reviewNone
        ? undefined
        : "What should the fix change? (enter sends the review's findings alone)";
    };

    const settle = (
      result: ApplyRecoveryActionResult,
      comment?: UserMessageInput,
      steer?: UserMessageInput,
    ): PendingRecoveryResult | null => {
      setInlineResume(result.state);

      if (!result.ok) {
        feedbackStore.setError(result.message);
        // The engine must stay parked on this halt. Returning shouldRun here re-enters the
        // workflow with the same pending issue before the operator can choose another action.
        return null;
      }

      feedbackStore.reset();

      const status = deriveRunStatus({
        state: result.state,
        liveness: 'not-alive',
        reviewNone: false,
      });
      if (status.kind === 'closed') {
        // The close is on the state; the run loop finalizes the session from it —
        // one summary, one receipt release, through the same path every other
        // ending takes.
        feedbackStore.setMessage(
          `Run ${status.as === 'complete' ? 'closed' : 'ended'}.${filesStillOnDiskSuffix({ projectDir, sessionId }, result.state)}`,
        );
        return { shouldRun: false, state: result.state };
      }

      const continuationSteer =
        result.status === 'retry-current-task'
          ? steer
          : result.status === 'continued' && !result.correctionRecorded
            ? comment
            : undefined;
      const steered =
        continuationSteer !== undefined && continuationSteer.text.trim() !== ''
          ? { steer: continuationSteer }
          : {};
      const updatedPreparation =
        result.currentConfig === undefined
          ? {}
          : { prepared: { ...prepared, config: parsePreparedConfig(result.currentConfig) } };
      return {
        shouldRun: true,
        state: result.state,
        ...updatedPreparation,
        ...steered,
        ...(result.status === 'continued' && result.correctionRecorded
          ? { correctionTaken: true }
          : {}),
      };
    };

    const applyAction = async (
      action: RecoveryAction,
      comment?: UserMessageInput,
      steer?: UserMessageInput,
    ): Promise<PendingRecoveryResult | null> => {
      if (action === 'switch-seat') {
        const offer = issue.switchSeat;
        const offered = offer?.candidates[0];
        if (offer === undefined || offered === undefined) {
          feedbackStore.setMessage('No other tool is offered for this seat.');
          return null;
        }
        const profile = offer.seat === 'build' ? issue.selectedImplementerProfile : undefined;
        const configured = seatIn(configOfRun, offer.seat, profile);
        // A halt saved before the offer recorded its seat has no `from`: the run's config names it.
        const ranOn = offer.from ?? configured;
        const kept: SeatSwapCandidate[] = [];
        if (ranOn !== undefined) kept.push(ranOn);
        // Preparation names the model a configured seat leaves to its tool: when the prepared
        // seat is the one the call ran on, the configured seat is that seat too.
        const preparedSeat = seatIn(config, offer.seat, profile);
        if (
          configured !== undefined &&
          preparedSeat !== undefined &&
          ranOn !== undefined &&
          sameSeatCandidate(preparedSeat, ranOn)
        ) {
          kept.push(configured);
        }
        // The picker reads the halt on the view and saves to the profile it names, also when a
        // reopened run replays this switch at once.
        recoveryNoticeStore.open();
        const candidate = await pickSwappedSeat(
          offer.seat,
          offered,
          kept,
          controller.signal,
          profile,
        );
        if (controller.signal.aborted || abortedRef.current) return { shouldRun: false, state };
        if (candidate === undefined) return null;
        feedbackStore.reset();
        return {
          shouldRun: true,
          state,
          switchSeat: { candidate, policy: runResumePolicy(prepared.runtime) },
        };
      }

      const result = await applyRecoveryAction({
        projectDir,
        sessionId,
        state,
        action,
        bus,
        config,
        // End run reads no config, so a file that does not load cannot keep the run open.
        ...(action === 'end-run' ? {} : { entryConfig: nextEntryConfig(entry).config }),
        ...(comment === undefined || comment.text.trim() === '' ? {} : { comment }),
      });
      return settle(result, comment, steer);
    };

    if (issue.status === 'applying') {
      const selected = issue.selectedAction;
      if (selected !== undefined) {
        // A replay asks nothing: the words typed to continue are the note of an action that takes
        // one, as the panel would take them, and steer the step it runs.
        const takesNote =
          selected === nextPass.correctionAction || noteQuestion(selected) !== undefined;
        const applied = await applyAction(
          selected,
          takesNote ? reentryCorrection : undefined,
          reentryCorrection,
        );
        if (applied !== null) return applied;
      } else {
        feedbackStore.setError('Recovery is applying but no action is selected.');
      }
    }

    // After Decide for me, a halt with a decided step takes it with no panel, unless the user
    // typed words to continue: those answer the halt as they do without the choice.
    const decided = applyDecidedRecovery(
      { projectDir, sessionId, state, bus, config },
      () => nextEntryConfig(entry).config,
      reentryCorrection,
    );
    if (decided !== undefined) {
      const settled = settle(await decided);
      if (settled !== null) return settled;
    }

    // Words typed to continue the run answer the halt when only its revise can carry them; a
    // retry halt keeps them as the steer of whichever retry the operator picks on the panel. Only
    // a halt End run alone answers has no step to take them.
    if (reentryCorrection !== undefined && reentryCorrection.text.trim() !== '') {
      if (nextPass.correctionAction === 'revise') {
        const applied = await applyAction(nextPass.correctionAction, reentryCorrection);
        if (applied !== null) return applied;
      } else if (issue.availableActions.every((action) => action === 'end-run')) {
        feedbackStore.setMessage(NO_CORRECTION_MESSAGE);
      }
    }

    // The panel is open only while it waits on the operator: an action the entry applies at once
    // — a reopened run's selected action, words only revise can carry — opens no panel.
    recoveryNoticeStore.open();

    if (!retentionNoticeHandled.current) {
      await publishRetainedWorkspaceNotice({ ...ref, state, bus });
      retentionNoticeHandled.current = true;
    }
    if (controller.signal.aborted || abortedRef.current) return { shouldRun: false, state };

    if (republishPrompt) {
      publishRecoveryPrompted(
        { bus, phase: state.phase },
        sessionId,
        issue,
        nextPass.at,
        nextPass.reviewNone,
      );
    }

    // One wait serves the panel and its note question. While a question waits, the next pass and
    // the view follow a move of REVIEW: once answered, this state is stale. A move that changes the
    // question ends it with no answer. The file is read when the answer comes, so a hand edit
    // counts too; End run reads none. An answer that the file or a move leaves with no question is
    // not taken, and its words go back to the composer.
    const waitForAnswer = async (
      question: string,
      stillAsked: () => boolean,
    ): Promise<QuestionAnswer | undefined> => {
      const moved = Promise.withResolvers<undefined>();
      const follow = (): void => {
        nextPass = readNextPass();
        updateWaitingHalt(state, nextPass.reviewNone);
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
    };

    while (true) {
      recoveryNoticeStore.ask(true);
      const waited = await waitForAnswer(formatRecoveryPrompt(issue), () => true);
      recoveryNoticeStore.ask(false);
      if (controller.signal.aborted || abortedRef.current) {
        return { shouldRun: false, state };
      }
      if (waited === undefined) continue;
      const { message: answer, document, row } = waited;
      const { reviewNone, stepReadsNone, correctionAction } = nextPass;
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
          supportsImages: plannerSupportsImages(config, modelCacheStore),
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
      const question = comment === undefined ? noteQuestion(action) : undefined;
      if (question !== undefined) {
        const note = await waitForAnswer(question, () => noteQuestion(action) === question);
        if (controller.signal.aborted || abortedRef.current) {
          return { shouldRun: false, state };
        }
        if (note === undefined) continue;
        comment = note.message;
      }
      const applied = await applyAction(action, comment, correction ?? reentryCorrection);
      if (applied !== null) return applied;
    }
  }

  return async function promptPendingRecovery(
    args: PromptPendingRecoveryArgs,
  ): Promise<PendingRecoveryResult> {
    const resetMode = (): void => inputMode.resetMode();
    args.controller.signal.addEventListener('abort', resetMode);
    try {
      return await promptRecovery(args);
    } finally {
      args.controller.signal.removeEventListener('abort', resetMode);
      recoveryNoticeStore.clear();
    }
  };
}
