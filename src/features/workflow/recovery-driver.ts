import { readActiveRunner } from '../../core/config/accessors/active-runner.js';
import { sameSeatCandidate, type CrewSeatId } from '../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import {
  seatPickerOverlayFor,
  toolRowFocus,
  type OverlayType,
} from '../../core/navigation/types.js';
import type { RecoveryAction } from '../../core/schemas/enums.js';
import type { StepRef } from '../../core/schemas/run-step.js';
import type { RecoveryIssue, SeatSwapCandidate } from '../../core/schemas/recovery/schemas.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { UserMessageInput } from '../../core/types/user-input.js';
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

const NO_CORRECTION_MESSAGE = 'This halt takes no typed correction. Choose one of its actions.';

type PendingRecoveryResult =
  | {
      shouldRun: true;
      state: WorkflowState;
      prepared?: PreparedExecution | undefined;
      retryProfileOverride?: string | undefined;
      retryProfileOverrideTaskId?: TaskId | undefined;
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
  inputMode: UseInputModeResult;
  abortedRef: { current: boolean };
  retentionNoticeHandled: { current: boolean };
  /** Where the panel's own events land on screen; the engine adds the session log. */
  sink: EventSink;
  setInlineResume: (state: WorkflowState) => void;
}

/**
 * The open halt, published for the rest of the screen while the operator reads the panel: the
 * issue itself, the step the run resumes at, and the two things the header annotates the bar
 * with — the halted seat and, when the runner named one, the clock its quota comes back on.
 */
function openRecoveryNotice(issue: RecoveryIssue, at: StepRef): void {
  const resetAt = issue.resetAt === undefined ? Number.NaN : Date.parse(issue.resetAt);
  recoveryNoticeStore.open({
    seat: issue.seat ?? null,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
    issue,
    at,
  });
}

/** Resolves once the picker has closed, or the run is aborted while it is open. */
function overlayClosed(overlay: OverlayType, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => {};
    const settle = (): void => {
      unsubscribe();
      signal.removeEventListener('abort', settle);
      resolve();
    };
    unsubscribe = overlayStore.subscribe(() => {
      if (overlayStore.get().active !== overlay) settle();
    });
    signal.addEventListener('abort', settle);
    if (signal.aborted || overlayStore.get().active !== overlay) settle();
  });
}

/** The seat as the config of record has it now; a seat that runs no CLI tool cannot be swapped. */
function seatOfRecord(seat: CrewSeatId): SeatSwapCandidate | undefined {
  const config = configStore.get().config;
  if (config === null) return undefined;
  const runner = readActiveRunner({ config, role: CREW_SEAT_ROLES[seat] });
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
 * model and effort drafted. The picker writes the config of record and the swap
 * is read back from it; a picker closed on the seat it opened on — same tool,
 * model, effort and variant — is a cancelled swap.
 */
async function pickSwappedSeat(
  seat: CrewSeatId,
  candidate: SeatSwapCandidate,
  signal: AbortSignal,
): Promise<SeatSwapCandidate | undefined> {
  const before = seatOfRecord(seat);
  const overlay = seatPickerOverlayFor(CREW_SEAT_ROLES[seat]);
  if (candidate.model !== undefined) {
    pickerViewStore.expand(
      candidate.model,
      candidate.model,
      candidate.effort ?? candidate.variant ?? null,
    );
  }
  overlayStore.open(overlay, toolRowFocus(candidate.tool));
  await overlayClosed(overlay, signal);
  const after = seatOfRecord(seat);
  if (after === undefined) return undefined;
  if (before !== undefined && sameSeatCandidate(after, before)) return undefined;
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
  const { prepared, inputMode, abortedRef, retentionNoticeHandled, sink, setInlineResume } = opts;
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
    const promptRecoveryComment = async (
      action: RecoveryAction,
    ): Promise<UserMessageInput | undefined> => {
      if (action === 'accept-as-is' && issue.reason === 'review-input-too-large') {
        return inputMode.setQuestionMode('Why skip the review? (enter records none)');
      }
      if (action !== 'revise') return undefined;
      return inputMode.setQuestionMode(
        issue.reason === 'review-failed'
          ? "What should the fix change? (enter sends the review's findings alone)"
          : 'What should the planner change? (enter sends no note)',
      );
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
          openRecoveryNotice(issue, at);
          return null;
        }
        const candidate = await pickSwappedSeat(offer.seat, offered, controller.signal);
        if (controller.signal.aborted || abortedRef.current) return { shouldRun: false, state };
        if (candidate === undefined) {
          openRecoveryNotice(issue, at);
          return null;
        }
        feedbackStore.reset();
        return {
          shouldRun: true,
          state,
          switchSeat: { candidate, policy: runResumePolicy(prepared.runtime) },
        };
      }

      const retryProfileOverrideTaskId = issue.taskId ?? state.tasks[state.currentTaskIndex]?.id;
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
        openRecoveryNotice(issue, at);
        return null;
      }

      feedbackStore.reset();

      const status = deriveRunStatus({ state: result.state, liveness: 'not-alive' });
      if (status.kind === 'closed') {
        // The close is on the state; the run loop finalizes the session from it —
        // one summary, one receipt release, through the same path every other
        // ending takes.
        feedbackStore.setMessage(
          `Run ${status.as === 'complete' ? 'closed' : 'ended'}.${filesStillOnDiskSuffix(result.state)}`,
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
      const retryProfileOverride = result.implementerProfile ?? issue.selectedImplementerProfile;
      if (retryProfileOverride === undefined || result.status !== 'retry-current-task') {
        return {
          shouldRun: true,
          state: result.state,
          ...updatedPreparation,
          ...steered,
          ...(result.status === 'continued' && result.correctionRecorded
            ? { correctionTaken: true }
            : {}),
        };
      }
      return {
        shouldRun: true,
        state: result.state,
        retryProfileOverride,
        ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
        ...updatedPreparation,
        ...steered,
      };
    };

    if (issue.status === 'applying') {
      const selected = issue.selectedAction;
      if (selected !== undefined) {
        const applied = await applyAction(selected);
        if (applied !== null) return applied;
      } else {
        feedbackStore.setError('Recovery is applying but no action is selected.');
      }
    }

    // Words typed to continue the run answer the halt when only its revise can carry them; a
    // retry halt keeps them as the steer of whichever retry the operator picks on the panel.
    const correctionAction = correctionActionFor(issue);
    if (reentryCorrection !== undefined && reentryCorrection.text.trim() !== '') {
      if (correctionAction === 'revise') {
        const applied = await applyAction(correctionAction, '', reentryCorrection);
        if (applied !== null) return applied;
      } else if (correctionAction === undefined) {
        feedbackStore.setError(NO_CORRECTION_MESSAGE);
      }
    }

    if (!retentionNoticeHandled.current) {
      await publishRetainedWorkspaceNotice({ ...ref, state, bus });
      retentionNoticeHandled.current = true;
    }
    if (controller.signal.aborted || abortedRef.current) return { shouldRun: false, state };

    if (republishPrompt) publishRecoveryPrompted({ bus, phase: state.phase }, sessionId, issue);

    openRecoveryNotice(issue, at);

    while (true) {
      const answer = await inputMode.setQuestionMode(formatRecoveryPrompt(issue));
      if (controller.signal.aborted || abortedRef.current) {
        return { shouldRun: false, state };
      }
      let action = parseRecoveryActionAnswer(answer.displayText, issue);
      let correction: UserMessageInput | undefined;
      if (action === null && answer.text.trim() !== '') {
        if (correctionAction === undefined) {
          feedbackStore.setError(NO_CORRECTION_MESSAGE);
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
