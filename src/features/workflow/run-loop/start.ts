import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { hydrateFromState } from '../../../stores/workflow/actions/hydrate.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { resetMarkdownConversationRowsCache } from '../conversation-rows/markdown-rows/build.js';
import { resetConversationRowsProjectionCache } from '../conversation-rows/cache/projection.js';
import { resetEventBlockCache } from '../conversation-rows/cache/block.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { configStore } from '../../../stores/project/config.js';
import { hasStaleHalt } from '../../../engine/orchestrator/run/init/resume-repair.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../../engine/events/workflow-cancel.js';
import type { WorkflowSinks } from '../../../engine/orchestrator/types.js';
import { addTuiEvent } from '../tui-sink.js';
import {
  createAbortHandlerScope,
  setCancelHandler,
  setStopHandler,
  setClearQueueHandler,
  setQueueHandler,
} from '../run-requests/registry.js';
import {
  consumeBoundaryInterrupt,
  consumeBoundaryPause,
  seatChangeWaits,
} from '../run-requests/boundary.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { endRunError } from '../../../engine/orchestrator/run/close.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { composerLiveStore } from '../../../stores/ui/composer-live.js';
import { stopStore, takesSeatAtBoundary } from '../../../stores/workflow/stop.js';
import { closeApprovalPrompt } from '../../../stores/prompts/approval.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { recordRunTerms } from '../resume/policy.js';
import { hydrateResume, resumeFailureMessage } from '../resume/hydration.js';
import { clearSessionScopedStores } from '../session-stores.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { finishStoppedRun } from './finish-stopped.js';
import { runPass } from './pass.js';
import { requestSeatChanges, runCallbacks } from './run-callbacks.js';
import type { RunLoop, TuiWorkflowInput } from './types.js';

function isWorkflowAborted(controller: AbortController, ref: { current: boolean }): boolean {
  return controller.signal.aborted || ref.current;
}

/** The run opens the stop sheet by itself only over an empty composer: a draft keeps the keys. */
export function openStopSheetOverEmptyComposer(): void {
  if (composerLiveStore.get().empty) overlayStore.open('stop-sheet');
}

/**
 * One re-entry of the run in the TUI: one `runWorkflow` call per turn and the recovery panel
 * between turns, until the run is at rest, stops or is superseded.
 */
export async function runTuiWorkflow(input: TuiWorkflowInput): Promise<void> {
  const { prepared, inputMode, abortedRef, retentionNoticeHandled, controller, settleRun } = input;
  const { inlineResume } = input.continuation;
  const inlineForPrepared =
    inlineResume !== undefined && inlineResume.prepared === prepared ? inlineResume : undefined;
  recordRunTerms(prepared);
  retentionNoticeHandled.current = true;
  const { session } = prepared;
  // A fresh abort-handler scope per run: a superseded run's late pops (its
  // aborted body settles after the rewind cleanup) drain its own scope and
  // cannot steal this run's live handler.
  const sinks: WorkflowSinks = {
    setAbortHandler: createAbortHandlerScope(),
    setClearQueueHandler,
    setQueueHandler,
    consumeBoundaryInterrupt,
    consumeBoundaryPause,
    seatChangeWaits,
    getContinuationResumedAt: () => lifecycleStore.get().resumedAt,
  };
  let state = inlineForPrepared?.state;
  if (state === undefined && prepared.runtime.resumeState !== undefined) {
    const hydrated = hydrateResume(session.ref);
    if (hydrated.kind === 'invalid') {
      inputMode.resetMode();
      clearSessionScopedStores();
      addTuiEvent({
        type: 'error',
        ts: Date.now(),
        phase: runViewStore.get().phase,
        message: resumeFailureMessage(hydrated),
      });
      return;
    }
    if (hydrated.kind === 'missing') {
      inputMode.resetMode();
      clearSessionScopedStores();
      return;
    }
    state = hydrated.state;
  }
  const loop: RunLoop = {
    input,
    sinks,
    state,
    steer: inlineForPrepared?.steer ?? input.steer,
    resumeCause: input.resumeCause,
    recoveryPromptPublished: false,
    staleHalt: state !== undefined && hasStaleHalt(state),
    switchSeat: undefined,
    prepared,
    configOfRun: prepared.sourceConfig,
    seatChangedAtBoundary: undefined,
    steerAtBoundary: plainUserMessage(''),
  };

  // A fresh run starts from an empty screen; a run this screen is continuing already has its
  // history on it, replayed at the navigation event or appended by its earlier passes, and the
  // live bus appends from here. Either way the saved state is laid over the stores, so the brief
  // list and the spend are the run's. A stop that parked the run before belongs to the pass it
  // ended; the pass starting here is live and stops afresh.
  if (state === undefined) resetWorkflow();
  if (state !== undefined) {
    stopStore.reset();
    hydrateFromState(state, configStore.reviewNone());
  }
  resetMarkdownConversationRowsCache();
  resetConversationRowsProjectionCache();
  resetEventBlockCache();
  conversationScrollStore.reset();
  setStopHandler(() => {
    controller.abort();
    inputMode.resetMode();
    closeApprovalPrompt();
    stopStore.get().parked?.resolve?.(plainUserMessage(''));
  });
  setCancelHandler(() => {
    controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
    inputMode.resetMode();
    closeApprovalPrompt();
    stopStore.get().parked?.resolve?.(plainUserMessage(''));
  });

  const offConfig = configStore.subscribe(() => {
    if (takesSeatAtBoundary()) requestSeatChanges(loop);
  });
  const callbacks = runCallbacks(loop);

  try {
    while (!isWorkflowAborted(controller, abortedRef)) {
      if ((await runPass(loop, callbacks)) === 'end') return;
    }
  } catch (err) {
    if (abortedRef.current) return;
    const message = toErrorMessage(err);
    if (endRunError.isApplying(err)) {
      await settleRun(session.ref, true);
      feedbackStore.setError(message);
      return;
    }
    addTuiEvent({ type: 'error', ts: Date.now(), phase: runViewStore.get().phase, message });
    if (stopStore.get().intent !== 'none') {
      stopStore.fail(message);
      // Retry only cleanup and persistence, never the interrupted model call.
      setStopHandler(() => {
        void (async () => {
          try {
            await finishStoppedRun(loop);
          } catch (retryError) {
            stopStore.fail(toErrorMessage(retryError));
          }
        })();
      });
      openStopSheetOverEmptyComposer();
    } else {
      await settleRun(session.ref, true);
    }
  } finally {
    offConfig();
  }
}
