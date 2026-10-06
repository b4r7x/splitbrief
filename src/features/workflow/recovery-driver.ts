import { readActiveRunner } from '../../core/config/accessors/active-runner.js';
import type { CrewSeatId } from '../../core/crew/identity.js';
import { CREW_SEAT_ROLES } from '../../core/crew/seats.js';
import {
  seatPickerOverlayFor,
  toolRowFocus,
  type OverlayType,
} from '../../core/navigation/types.js';
import type { RecoveryAction } from '../../core/schemas/enums.js';
import type { RecoveryIssue, SeatSwapCandidate } from '../../core/schemas/recovery/schemas.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { deriveRunStatus } from '../../core/sessions/run-status.js';
import type { EventSink } from '../../engine/events/types.js';
import { createRecoveryBus } from '../../engine/orchestrator/recovery/bus.js';
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
      steer?: string | undefined;
      /** The words the run was continued with were this halt's correction, and are spent. */
      correctionTaken?: true | undefined;
    }
  | { shouldRun: false; state?: WorkflowState | undefined };

interface PromptPendingRecoveryArgs {
  state: WorkflowState;
  controller: AbortController;
  republishPrompt: boolean;
  /** What the operator typed to continue the run, before the panel was on screen. */
  correction?: string | undefined;
}

interface RecoveryDriverOptions {
  prepared: PreparedExecution;
  inputMode: UseInputModeResult;
  abortedRef: { current: boolean };
  /** Where the panel's own events land on screen; the engine adds the session log. */
  sink: EventSink;
  setInlineResume: (state: WorkflowState) => void;
}

/**
 * The open halt, published for the rest of the screen while the operator reads the panel: the
 * issue itself, plus the two things the header annotates the bar with — the halted seat and, when
 * the runner named one, the clock its quota comes back on. Only the swap offer names a seat the
 * header can mark, so a halt without an offer still publishes itself and leaves the bar alone.
 */
function openRecoveryNotice(issue: RecoveryIssue): void {
  const resetAt = issue.resetAt === undefined ? Number.NaN : Date.parse(issue.resetAt);
  recoveryNoticeStore.open({
    seat: issue.switchSeat?.seat ?? null,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
    issue,
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
 * The offered tool is preselected in the seat's own picker, the one place a seat's model and
 * effort are chosen. The picker writes the config of record and the swap is read back from it;
 * a picker closed on the seat it opened on is a cancelled swap.
 */
async function pickSwappedSeat(
  seat: CrewSeatId,
  tool: string,
  signal: AbortSignal,
): Promise<SeatSwapCandidate | undefined> {
  const before = seatOfRecord(seat);
  const overlay = seatPickerOverlayFor(CREW_SEAT_ROLES[seat]);
  overlayStore.open(overlay, toolRowFocus(tool));
  await overlayClosed(overlay, signal);
  const after = seatOfRecord(seat);
  if (after === undefined || (after.tool === before?.tool && after.model === before?.model)) {
    return undefined;
  }
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
  const { prepared, inputMode, abortedRef, sink, setInlineResume } = opts;
  const { ref } = prepared.session;
  const { projectDir, sessionId } = ref;
  const config = prepared.config;

  return async function promptPendingRecovery({
    state,
    controller,
    republishPrompt,
    correction: reentryCorrection = '',
  }: PromptPendingRecoveryArgs): Promise<PendingRecoveryResult> {
    const issue = state.pendingRecovery;
    if (issue === undefined) return { shouldRun: true, state };

    const bus = createRecoveryBus({ projectDir, sessionId, sink });

    // `revise` carries the operator's words to the planner, so the panel asks for
    // them before it applies: an empty answer resolves the halt with no note.
    const promptRecoveryComment = async (action: RecoveryAction): Promise<string> => {
      if (action === 'accept-as-is' && issue.reason === 'review-input-too-large') {
        return inputMode.setQuestionMode('Why skip the review? (enter records none)');
      }
      if (action !== 'revise') return '';
      return inputMode.setQuestionMode(
        issue.reason === 'review-failed'
          ? "What should the fix change? (enter sends the review's findings alone)"
          : 'What should the planner change? (enter sends no note)',
      );
    };

    const applyAction = async (
      action: RecoveryAction,
      answer = '',
      comment = '',
      steer = '',
    ): Promise<PendingRecoveryResult | null> => {
      if (action === 'switch-seat') {
        const offer = issue.switchSeat;
        const offered = switchSeatCandidateForAnswer(answer, offer);
        if (offer === undefined || offered === undefined) {
          feedbackStore.setError('No other tool is offered for this seat.');
          openRecoveryNotice(issue);
          return null;
        }
        const candidate = await pickSwappedSeat(offer.seat, offered.tool, controller.signal);
        if (controller.signal.aborted || abortedRef.current) return { shouldRun: false, state };
        if (candidate === undefined) {
          openRecoveryNotice(issue);
          return null;
        }
        recoveryNoticeStore.clear();
        feedbackStore.reset();
        return {
          shouldRun: true,
          state,
          switchSeat: { candidate, policy: runResumePolicy(prepared) },
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
        ...(comment.trim() === '' ? {} : { comment }),
      });

      setInlineResume(result.state);

      if (!result.ok) {
        feedbackStore.setError(result.message);
        // The engine must stay parked on this halt. Returning shouldRun here re-enters the
        // workflow with the same pending issue before the operator can choose another action.
        openRecoveryNotice(issue);
        return null;
      }

      feedbackStore.reset();

      const status = deriveRunStatus({ state: result.state, liveness: 'not-alive' });
      if (status.kind === 'closed') {
        recoveryNoticeStore.clear();
        // The close is on the state; the run loop finalizes the session from it —
        // one summary, one receipt release, through the same path every other
        // ending takes.
        feedbackStore.setMessage(
          `Run ${status.as === 'complete' ? 'closed' : 'ended'}.${filesStillOnDiskSuffix(result.state.workspace)}`,
        );
        return { shouldRun: false, state: result.state };
      }

      recoveryNoticeStore.clear();
      // A replayed brief takes the typed words as its steer; a seat-level retry and a
      // revise already carried them to the planner as the comment.
      const steered =
        result.status === 'retry-current-task' && steer.trim() !== '' ? { steer } : {};
      const updatedPreparation =
        result.currentConfig === undefined
          ? {}
          : { prepared: { ...prepared, config: parsePreparedConfig(result.currentConfig) } };
      const retryProfileOverride = result.implementerProfile ?? issue.selectedImplementerProfile;
      if (retryProfileOverride === undefined || result.status !== 'retry-current-task') {
        return { shouldRun: true, state: result.state, ...updatedPreparation, ...steered };
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
    if (reentryCorrection.trim() !== '') {
      if (correctionAction === 'revise') {
        const applied = await applyAction(correctionAction, '', reentryCorrection);
        if (applied?.shouldRun === true) return { ...applied, correctionTaken: true };
        if (applied !== null) return applied;
      } else if (correctionAction === undefined) {
        feedbackStore.setError(NO_CORRECTION_MESSAGE);
      }
    }

    if (republishPrompt) publishRecoveryPrompted({ bus, phase: state.phase }, sessionId, issue);

    openRecoveryNotice(issue);

    while (true) {
      const answer = await inputMode.setQuestionMode(formatRecoveryPrompt(issue));
      if (controller.signal.aborted || abortedRef.current) {
        return { shouldRun: false, state };
      }
      let action = parseRecoveryActionAnswer(answer, issue);
      let correction = '';
      if (action === null && answer.trim() !== '') {
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
      const draft = composerLiveStore.get().text.trim();
      if (correction === '' && action === correctionAction && draft !== '') {
        correction = draft;
        composerDraftStore.request('');
      }
      const comment = correction === '' ? await promptRecoveryComment(action) : correction;
      if (controller.signal.aborted || abortedRef.current) {
        return { shouldRun: false, state };
      }
      const applied = await applyAction(action, answer, comment, correction);
      if (applied !== null) return applied;
    }
  };
}
