import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { readinessBlockerMessage } from '../../../core/readiness/format.js';
import { deriveRunStatus } from '../../../core/sessions/run/status.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../../engine/events/workflow-cancel.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import { applyOfferedSeatSwap } from '../../../engine/orchestrator/run/seat-swap.js';
import { finalizeEndedRun } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import type { StreamingSink } from '../../../engine/orchestrator/task/streaming-feed.js';
import type { OrchestratorCallbacks } from '../../../engine/orchestrator/types.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { configStore } from '../../../stores/project/config.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { hydrateFromState } from '../../../stores/workflow/actions/hydrate.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { createRecoveryDriver } from '../recovery/driver.js';
import { runResumePolicy } from '../resume/policy.js';
import { hydrateResume, resumeFailureMessage } from '../resume/hydration.js';
import { spendSeatChange } from '../run-requests/boundary.js';
import { clearSessionScopedStores } from '../session-stores.js';
import { addTuiEvent } from '../tui-sink.js';
import { finishStoppedRun } from './finish-stopped.js';
import { requestSeatChanges } from './run-callbacks.js';
import { nextEntryConfig, swapBaseConfig } from './seat-config.js';
import type { RunLoop } from './types.js';

/**
 * One pass of the run loop: the recovery panel when the run waits on a halt, the seat swap the
 * panel took, the admission of the session again, and one `runWorkflow` call. `next-pass` turns
 * the loop again; `end` returns from it.
 */
export async function runPass(
  loop: RunLoop,
  callbacks: OrchestratorCallbacks,
): Promise<'next-pass' | 'end'> {
  const halted = loop.state;
  if (halted?.pendingRecovery !== undefined && !loop.staleHalt) {
    if ((await answerHalt(loop, halted)) === 'end') return 'end';
  }
  loop.staleHalt = false;
  const swap = await takeSeatSwap(loop);
  if (swap !== 'next-step') return swap;
  if ((await admitAgain(loop)) === 'end') return 'end';
  return enterEngine(loop, callbacks);
}

async function answerHalt(loop: RunLoop, state: WorkflowState): Promise<'next-step' | 'end'> {
  const { inputMode, abortedRef, retentionNoticeHandled, controller, settleRun } = loop.input;
  const { prepared, continuation } = loop.input;
  const promptPendingRecovery = createRecoveryDriver({
    prepared: loop.prepared,
    configOfRun: loop.configOfRun,
    inputMode,
    abortedRef,
    retentionNoticeHandled,
    sink: addTuiEvent,
    setInlineResume: (saved) => continuation.setInlineResume({ prepared, state: saved }),
  });
  const recovery = await promptPendingRecovery({
    state,
    controller,
    republishPrompt: !loop.recoveryPromptPublished,
    correction: loop.steer,
  }).catch((err: unknown) => {
    if (controller.signal.aborted && err === WORKFLOW_USER_CANCELLED_ABORT_REASON)
      return { shouldRun: false as const, state: loop.state };
    throw err;
  });
  if (controller.signal.aborted) {
    if (!abortedRef.current) await finishStoppedRun(loop);
    return 'end';
  }
  loop.recoveryPromptPublished = false;
  if (!recovery.shouldRun) {
    // Ending a run from the recovery panel never re-enters the engine, so
    // the session record is written here through the normal finalize.
    const closedState = recovery.state;
    if (
      closedState !== undefined &&
      deriveRunStatus({ state: closedState, liveness: 'not-alive', reviewNone: false }).kind ===
        'closed'
    ) {
      finalizeEndedRun({
        ref: loop.prepared.session.ref,
        active: loop.prepared.session.active,
        state: closedState,
        modelCache: modelCacheStore,
      });
    }
    await settleRun(prepared.session.ref, true);
    return 'end';
  }
  if (recovery.prepared !== undefined) loop.prepared = recovery.prepared;
  loop.state = recovery.state;
  loop.switchSeat = recovery.switchSeat;
  loop.steer = recovery.correctionTaken === true ? undefined : (recovery.steer ?? loop.steer);
  return 'next-step';
}

/**
 * A taken seat swap resolves the halt onto the new tool and prepares this session on it. That is
 * this re-entry's preparation: the seat that halted is not admitted again, so a tool that can no
 * longer run cannot block the move away from it.
 */
async function takeSeatSwap(loop: RunLoop): Promise<'next-step' | 'next-pass' | 'end'> {
  const { switchSeat, state } = loop;
  if (switchSeat === undefined || state === undefined) return 'next-step';
  const { controller, abortedRef, prepareExecution } = loop.input;
  const { ref } = loop.input.prepared.session;
  configStore.reloadIfChanged();
  const swappedSeat = state.pendingRecovery?.switchSeat?.seat;
  const savedConfig = configStore.get().config;
  const swapped = await applyOfferedSeatSwap({
    choice: switchSeat,
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    bus: createRecoveryBus({ ...ref, sink: addTuiEvent }),
    config:
      savedConfig === null || swappedSeat === undefined
        ? loop.prepared.config
        : swapBaseConfig(savedConfig, loop.prepared.config, swappedSeat),
    prepared: loop.prepared,
    savedState: state,
    signal: controller.signal,
    prepare: prepareExecution,
    onSeatSwapped: (swappedPrepared) => {
      loop.prepared = swappedPrepared;
      loop.configOfRun = swappedPrepared.sourceConfig;
      configStore.refreshFromExecution(ref.projectDir, swappedPrepared.config);
      // The swap prepared from the saved config, so it took every seat saved before it.
      if (swappedSeat !== undefined) spendSeatChange();
    },
  });
  loop.switchSeat = undefined;
  if (controller.signal.aborted) {
    if (!abortedRef.current) await finishStoppedRun(loop);
    return 'end';
  }
  const current = swapped === undefined ? state : swapped.state;
  loop.state = current;
  // An automatic intent whose swap did not resolve the halt is spent: the halt
  // stays pending, with no intent to take the same fallback again, so the next
  // entry shows the panel and the operator picks the seat by hand.
  const pending = current.pendingRecovery;
  const spent = pending?.switchSeat;
  if (pending === undefined || spent?.auto === undefined) return 'next-step';
  const { auto: _auto, ...unattended } = spent;
  loop.state = { ...current, pendingRecovery: { ...pending, switchSeat: unattended } };
  return 'next-pass';
}

/**
 * A run started here was prepared to allocate its session, and that preparation starts a session
 * only once. Every later entry continues the session, so it is admitted again as a resume before
 * it re-enters the engine. A seat saved since the run was prepared is admitted here on any
 * re-entry, from the saved config, so the run continues on it.
 */
async function admitAgain(loop: RunLoop): Promise<'next-step' | 'end'> {
  const { controller, abortedRef, prepareExecution, settleRun } = loop.input;
  const { ref } = loop.input.prepared.session;
  const { state } = loop;
  const entry = nextEntryConfig({
    configOfRun: loop.configOfRun,
    prepared: loop.prepared.config,
    state,
  });
  if (state === undefined || (loop.prepared.purpose !== 'new-workflow' && !entry.seatsSaved))
    return 'next-step';
  const reprepared = await prepareExecution({
    existingSession: ref,
    feature: state.feature,
    effectiveConfig: entry.config,
    configWarnings: [],
    policy: runResumePolicy(loop.prepared.runtime),
    signal: controller.signal,
    resumeState: state,
  });
  if (reprepared.kind === 'aborted') {
    if (!abortedRef.current) await finishStoppedRun(loop);
    return 'end';
  }
  if (reprepared.kind !== 'prepared') {
    addTuiEvent({
      type: 'error',
      ts: Date.now(),
      phase: runViewStore.get().phase,
      message:
        reprepared.kind === 'blocked'
          ? `Cannot resume: ${readinessBlockerMessage(reprepared.report)}`
          : `Cannot resume: ${toErrorMessage(reprepared.error)}`,
    });
    await settleRun(ref, true);
    return 'end';
  }
  loop.prepared = reprepared.execution;
  // The saved seats are taken now, so the compare before the engine entry spends the change.
  if (entry.seatsSaved) loop.configOfRun = reprepared.execution.sourceConfig;
  return 'next-step';
}

/** One `runWorkflow` call, then the run at rest, a stop, or the halt the next pass answers. */
async function enterEngine(
  loop: RunLoop,
  callbacks: OrchestratorCallbacks,
): Promise<'next-pass' | 'end'> {
  const { inputMode, abortedRef, retentionNoticeHandled, controller, settleRun } = loop.input;
  const { prepared, continuation, continueAtRest, selectedSkills } = loop.input;
  const { ref } = prepared.session;
  const storeStreamingSink: StreamingSink = {
    start: (tid) => streamingOutputStore.startStreaming(tid),
    replaceLines: (lines) => streamingOutputStore.replaceLines(lines),
    stop: () => streamingOutputStore.stopStreaming(),
  };

  requestSeatChanges(loop);
  const detectedContextLength = configStore.getDetectedContextLength();
  retentionNoticeHandled.current = false;
  await loop.input.runWorkflow({
    prepared: loop.prepared,
    sinks: loop.sinks,
    tuiSink: addTuiEvent,
    modelCache: modelCacheStore,
    drainPendingAttachments: () => attachmentsStore.drain(),
    streamingSink: storeStreamingSink,
    signal: controller.signal,
    callbacks,
    savedState: loop.state,
    selectedSkills,
    ...(loop.steer !== undefined && { steer: loop.steer }),
    ...(loop.resumeCause !== undefined && { resumeCause: loop.resumeCause }),
    ...(detectedContextLength !== undefined && { detectedContextLength }),
  });
  loop.steer = undefined;
  loop.resumeCause = undefined;

  if (abortedRef.current) return 'end';
  if (controller.signal.aborted) {
    if (stopStore.get().intent === 'end-run') await finishStoppedRun(loop);
    else if (loop.seatChangedAtBoundary === 'continue') {
      stopStore.reset();
      const refusal = continueAtRest?.(
        await settleRun(ref, false),
        loop.steerAtBoundary,
        'seat-change',
      );
      if (refusal !== undefined) feedbackStore.setMessage(refusal);
    } else await settleRun(ref, true);
    return 'end';
  }

  const hydrated = hydrateResume(ref);
  if (hydrated.kind === 'invalid') {
    inputMode.resetMode();
    clearSessionScopedStores();
    addTuiEvent({
      type: 'error',
      ts: Date.now(),
      phase: runViewStore.get().phase,
      message: resumeFailureMessage(hydrated),
    });
    await settleRun(ref, true);
    return 'end';
  }
  const saved = hydrated.kind === 'loaded' ? hydrated.state : null;

  // A halt is the only thing that keeps this loop turning: the recovery panel runs in this
  // process, answers, and re-enters the engine. Every other return is the run at rest, and
  // the screen it is already on paints it from its re-read record.
  if (!saved?.pendingRecovery) {
    await settleRun(ref, true);
    return 'end';
  }

  loop.state = saved;
  continuation.setInlineResume({ prepared, state: saved });
  loop.recoveryPromptPublished = true;
  // The event bound swaps an oversized prompt event for a warning: the view has no halt yet.
  if (runViewStore.get().halt === null) hydrateFromState(saved, configStore.reviewNone());
  return 'next-pass';
}
