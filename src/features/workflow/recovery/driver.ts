import { publishRecoveryPrompted } from '../../../engine/orchestrator/publish/recovery.js';
import { publishRetainedWorkspaceNotice } from '../../../engine/orchestrator/isolation/retention.js';
import { applyDecidedRecovery } from '../../../engine/orchestrator/recovery/actions/apply.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { runResumePolicy } from '../resume/policy.js';
import { nextEntryConfig } from '../run-loop/seat-config.js';
import { NO_CORRECTION_MESSAGE } from './actions.js';
import { applyAction } from './apply-action.js';
import { settle } from './settle.js';
import type {
  RecoveryDriverOptions,
  RecoveryDriverState,
  PromptPendingRecoveryArgs,
  PendingRecoveryResult,
} from './types.js';
import { askForAction, noteQuestion, readNextPass } from './wait-answer.js';

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
  return async function promptPendingRecovery(
    args: PromptPendingRecoveryArgs,
  ): Promise<PendingRecoveryResult> {
    const resetMode = (): void => opts.inputMode.resetMode();
    args.controller.signal.addEventListener('abort', resetMode);
    try {
      return await promptRecovery(opts, args);
    } finally {
      args.controller.signal.removeEventListener('abort', resetMode);
      recoveryNoticeStore.clear();
    }
  };
}

async function promptRecovery(
  opts: RecoveryDriverOptions,
  { state, controller, republishPrompt, correction: reentryCorrection }: PromptPendingRecoveryArgs,
): Promise<PendingRecoveryResult> {
  const issue = state.pendingRecovery;
  if (issue === undefined) return { shouldRun: true, state };
  const { prepared } = opts;

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

  const { ref } = prepared.session;
  const { projectDir, sessionId } = ref;
  const config = prepared.config;
  const entry = { configOfRun: opts.configOfRun, prepared: config, state };
  const bus = createRecoveryBus({ projectDir, sessionId, sink: opts.sink });
  const driver: RecoveryDriverState = {
    ...opts,
    state,
    issue,
    entry,
    bus,
    controller,
    reentryCorrection,
    nextPass: readNextPass(entry, issue),
  };

  if (issue.status === 'applying') {
    const selected = issue.selectedAction;
    if (selected !== undefined) {
      // A replay asks nothing: the words typed to continue are the note of an action that takes
      // one, as the panel would take them, and steer the step it runs.
      const takesNote =
        selected === driver.nextPass.correctionAction ||
        noteQuestion(driver, selected) !== undefined;
      const applied = await applyAction(
        driver,
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
    const settled = settle(driver, await decided);
    if (settled !== null) return settled;
  }

  // Words typed to continue the run answer the halt when only its revise can carry them; a
  // retry halt keeps them as the steer of whichever retry the operator picks on the panel. Only
  // a halt End run alone answers has no step to take them.
  if (reentryCorrection !== undefined && reentryCorrection.text.trim() !== '') {
    if (driver.nextPass.correctionAction === 'revise') {
      const applied = await applyAction(
        driver,
        driver.nextPass.correctionAction,
        reentryCorrection,
      );
      if (applied !== null) return applied;
    } else if (issue.availableActions.every((action) => action === 'end-run')) {
      feedbackStore.setMessage(NO_CORRECTION_MESSAGE);
    }
  }

  // The panel is open only while it waits on the operator: an action the entry applies at once
  // — a reopened run's selected action, words only revise can carry — opens no panel.
  recoveryNoticeStore.open();

  if (!opts.retentionNoticeHandled.current) {
    await publishRetainedWorkspaceNotice({ ...ref, state, bus });
    opts.retentionNoticeHandled.current = true;
  }
  if (controller.signal.aborted || opts.abortedRef.current) return { shouldRun: false, state };

  if (republishPrompt) {
    publishRecoveryPrompted(
      { bus, phase: state.phase },
      sessionId,
      issue,
      driver.nextPass.at,
      driver.nextPass.reviewNone,
    );
  }

  return askForAction(driver);
}
