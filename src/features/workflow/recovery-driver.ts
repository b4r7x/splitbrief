import { readActiveRunner } from '../../core/config/accessors/active-runner.js';
import { sameSeatCandidate, type CrewSeatId } from '../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import {
  seatPickerOverlayFor,
  toolRowFocus,
  type OverlayType,
} from '../../core/navigation/types.js';
import type { Config } from '../../core/schemas/config.js';
import type { RecoveryAction } from '../../core/schemas/enums.js';
import type { StepRef } from '../../core/schemas/run-step.js';
import type { RecoveryIssue, SeatSwapCandidate } from '../../core/schemas/recovery/schemas.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { haltedSeatIds } from '../../core/state/seats.js';
import type { UserMessageInput } from '../../core/types/user-input.js';
import { recoveryActionLabel } from '../../core/recovery/action-label.js';
import { leavesWordsUnread } from '../../core/recovery/typed-words.js';
import { prepareDraftSubmission } from '../../core/composer/submission.js';
import { plannerSupportsImages } from '../../core/runners/capabilities.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { attachmentsStore } from '../../stores/workflow/attachments.js';
import { formatSubmissionFailure } from '../../components/composer/home-hint.js';
import { deriveRunStatus, resumeStep } from '../../core/sessions/run-status.js';
import type { EventSink } from '../../engine/events/types.js';
import { createRecoveryBus } from '../../engine/orchestrator/recovery/bus.js';
import { publishRetainedWorkspaceNotice } from '../../engine/orchestrator/isolation/retention.js';
import { publishRecoveryPrompted } from '../../engine/orchestrator/events.js';
import { applyRecoveryAction } from '../../engine/orchestrator/recovery/actions.js';
import type { SeatSwapChoice } from '../../engine/orchestrator/run/seat-swap.js';
import { filesStillOnDiskSuffix } from '../../engine/orchestrator/run/close.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../engine/runners/prepared-execution.js';
import { configStore } from '../../stores/project/config.js';
import { composerDraftStore } from '../../stores/ui/composer-draft.js';
import { composerLiveStore } from '../../stores/ui/composer-live.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { pickerViewStore } from '../../stores/ui/picker-view.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { recoveryNoticeStore } from '../../stores/workflow/recovery-notice.js';
import { runResumePolicy } from './resume-policy.js';
import {
  correctionActionFor,
  formatRecoveryPrompt,
  parseRecoveryActionAnswer,
  switchSeatCandidateForAnswer,
} from './recovery-prompt.js';

const NO_CORRECTION_MESSAGE = 'This halt takes no typed correction. Choose an action.';

type PendingRecoveryResult =
  | {
      shouldRun: true;
      state: WorkflowState;
      prepared?: PreparedExecution | undefined;
      switchSeat?: SeatSwapChoice | undefined;
      /** The operator's typed correction, to seed the next call's prompt. */
      steer?: UserMessageInput | undefined;
      /** The words the run was continued with were this halt's correction, and are spent. */
      correctionTaken?: true | undefined;
    }
  | { shouldRun: false; state?: WorkflowState | undefined };

interface PromptPendingRecoveryArgs {
  state: WorkflowState;
  controller: AbortController;
  republishPrompt: boolean;
  /** What the operator typed to continue the run, before the panel was on screen. */
  correction?: UserMessageInput | undefined;
}

interface RecoveryDriverOptions {
  prepared: PreparedExecution;
  /** The config the run's seats were prepared from: it names the halted seat when the halt does not. */
  configOfRun: Config;
  inputMode: UseInputModeResult;
  abortedRef: { current: boolean };
  retentionNoticeHandled: { current: boolean };
  /** Where the panel's own events land on screen; the engine adds the session log. */
  sink: EventSink;
  setInlineResume: (state: WorkflowState) => void;
}

/**
 * The open halt, published for the rest of the screen while the operator reads the panel: the
 * issue itself, the step the run resumes at, and what the header annotates the bar with — the
 * halted seat, the tool and model it ran on, and, when the runner named one, the clock its quota
 * comes back on.
 */
function openRecoveryNotice(issue: RecoveryIssue, at: StepRef, ref: SessionRef): void {
  const resetAt = issue.resetAt === undefined ? Number.NaN : Date.parse(issue.resetAt);
  recoveryNoticeStore.open({
    seat: issue.seat ?? null,
    ranOn: haltedSeatIds(ref, issue),
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
    issue,
    at,
  });
}

/**
 * Resolves once the picker has closed, or the run is aborted while it is open, with whether
 * the picker took a row. The flag is read at the close itself: the picker's unmount resets it.
 */
function overlayClosed(overlay: OverlayType, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => {};
    const settle = (): void => {
      unsubscribe();
      signal.removeEventListener('abort', settle);
      resolve(pickerViewStore.get().committed);
    };
    unsubscribe = overlayStore.subscribe(() => {
      if (overlayStore.get().active !== overlay) settle();
    });
    signal.addEventListener('abort', settle);
    if (signal.aborted || overlayStore.get().active !== overlay) settle();
  });
}

/**
 * The seat as a config has it, on the BUILD profile the halt named; a seat that runs no CLI
 * tool cannot be swapped.
 */
function seatIn(
  config: Config | null,
  seat: CrewSeatId,
  profile: string | undefined,
): SeatSwapCandidate | undefined {
  if (config === null) return undefined;
  const runner = readActiveRunner({ config, role: CREW_SEAT_ROLES[seat], profile });
  if (runner.kind !== 'cli') return undefined;
  return {
    tool: runner.tool,
    ...(runner.model !== undefined && { model: runner.model }),
    ...(runner.effort !== undefined && { effort: runner.effort }),
    ...(runner.variant !== undefined && { variant: runner.variant }),
  };
}

/**
 * The chosen candidate is preselected in the seat's own picker, the one place a
 * seat's model and effort are chosen: the picker opens on its tool row with its
 * model and effort drafted. A row the picker takes is saved to the config of record,
 * and the swap is read back from it. A picker closed with no row taken (Escape, also
 * after Ctrl+D saved a deleted custom model) is a cancelled swap, and so is a take of
 * a `kept` seat: the seat the halted call ran on — same tool, model, effort and
 * variant — or the configured seat it was prepared from, which may leave its model to
 * the tool. A take of the seat a save under the halt already chose is a swap, also
 * after the run is opened again. A BUILD halt names the profile that failed: the picker
 * reads the open halt and saves to that profile, and the swap is read from it.
 */
async function pickSwappedSeat(
  seat: CrewSeatId,
  candidate: SeatSwapCandidate,
  kept: SeatSwapCandidate[],
  signal: AbortSignal,
  profile: string | undefined,
): Promise<SeatSwapCandidate | undefined> {
  const overlay = seatPickerOverlayFor(CREW_SEAT_ROLES[seat]);
  if (candidate.model !== undefined) {
    pickerViewStore.expand(
      candidate.model,
      candidate.model,
      candidate.effort ?? candidate.variant ?? null,
    );
  }
  pickerViewStore.setCommitted(false);
  overlayStore.open(overlay, toolRowFocus(candidate.tool));
  if (!(await overlayClosed(overlay, signal))) return undefined;
  const after = seatIn(configStore.get().config, seat, profile);
  if (after === undefined) return undefined;
  if (kept.some((seatKept) => sameSeatCandidate(after, seatKept))) return undefined;
  return after;
}

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
    const at = resumeStep(state);

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
      return issue.reason === 'review-failed'
        ? "What should the fix change? (enter sends the review's findings alone)"
        : 'What should the planner change? (enter sends no note)';
    };
    const promptRecoveryComment = async (
      action: RecoveryAction,
    ): Promise<UserMessageInput | undefined> => {
      const question = noteQuestion(action);
      return question === undefined
        ? undefined
        : (await inputMode.setQuestionMode(question)).message;
    };

    const applyAction = async (
      action: RecoveryAction,
      answer = '',
      comment?: UserMessageInput,
      steer?: UserMessageInput,
    ): Promise<PendingRecoveryResult | null> => {
      if (action === 'switch-seat') {
        const offer = issue.switchSeat;
        const offered = switchSeatCandidateForAnswer(answer, offer);
        if (offer === undefined || offered === undefined) {
          feedbackStore.setError('No other tool is offered for this seat.');
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
        // The picker reads the open halt and saves to the profile it names, also when a
        // reopened run replays this switch at once.
        openRecoveryNotice(issue, at, ref);
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
        ...(comment === undefined || comment.text.trim() === '' ? {} : { comment }),
      });

      setInlineResume(result.state);

      if (!result.ok) {
        feedbackStore.setError(result.message);
        // The engine must stay parked on this halt. Returning shouldRun here re-enters the
        // workflow with the same pending issue before the operator can choose another action.
        return null;
      }

      feedbackStore.reset();

      const status = deriveRunStatus({ state: result.state, liveness: 'not-alive' });
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

    const correctionAction = correctionActionFor(issue);
    if (issue.status === 'applying') {
      const selected = issue.selectedAction;
      if (selected !== undefined) {
        // A replay asks nothing: the words typed to continue are the note of an action that takes
        // one, as the panel would take them, and steer the step it runs.
        const takesNote = selected === correctionAction || noteQuestion(selected) !== undefined;
        const applied = await applyAction(
          selected,
          '',
          takesNote ? reentryCorrection : undefined,
          reentryCorrection,
        );
        if (applied !== null) return applied;
      } else {
        feedbackStore.setError('Recovery is applying but no action is selected.');
      }
    }

    // Words typed to continue the run answer the halt when only its revise can carry them; a
    // retry halt keeps them as the steer of whichever retry the operator picks on the panel. Only
    // a halt End run alone answers has no step to take them.
    if (reentryCorrection !== undefined && reentryCorrection.text.trim() !== '') {
      if (correctionAction === 'revise') {
        const applied = await applyAction(correctionAction, '', reentryCorrection);
        if (applied !== null) return applied;
      } else if (issue.availableActions.every((action) => action === 'end-run')) {
        feedbackStore.setError(NO_CORRECTION_MESSAGE);
      }
    }

    // The halt is open only while it waits on the operator: an action the entry applies at once
    // — a reopened run's selected action, words only revise can carry — paints no halt.
    openRecoveryNotice(issue, at, ref);

    if (!retentionNoticeHandled.current) {
      await publishRetainedWorkspaceNotice({ ...ref, state, bus });
      retentionNoticeHandled.current = true;
    }
    if (controller.signal.aborted || abortedRef.current) return { shouldRun: false, state };

    if (republishPrompt) publishRecoveryPrompted({ bus, phase: state.phase }, sessionId, issue);

    while (true) {
      const { message: answer, document } = await inputMode.setQuestionMode(
        formatRecoveryPrompt(issue),
      );
      if (controller.signal.aborted || abortedRef.current) {
        return { shouldRun: false, state };
      }
      let action = parseRecoveryActionAnswer(answer.displayText, issue);
      let correction: UserMessageInput | undefined;
      if (action === null && answer.text.trim() !== '') {
        if (correctionAction === undefined) {
          feedbackStore.setError(NO_CORRECTION_MESSAGE);
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
      if (!draft.empty && leavesWordsUnread(issue.reason, action)) {
        feedbackStore.setError(
          `Cannot send words with ${recoveryActionLabel(action, { reason: issue.reason })}. Clear them.`,
        );
        continue;
      }
      if (correction === undefined && action === correctionAction && !draft.empty) {
        const submission = prepareDraftSubmission(draft.document, {
          projectDir,
          supportsImages: plannerSupportsImages(config, modelCacheStore.getDetection().providers),
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
      const comment = correction ?? (await promptRecoveryComment(action));
      if (controller.signal.aborted || abortedRef.current) {
        return { shouldRun: false, state };
      }
      const applied = await applyAction(
        action,
        answer.displayText,
        comment,
        correction ?? reentryCorrection,
      );
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
