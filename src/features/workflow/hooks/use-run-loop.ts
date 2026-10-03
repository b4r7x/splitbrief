import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { TaskId } from '../../../core/schemas/task.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { RunRecord } from '../../../core/sessions/run-record.js';
import { readRunRecord } from '../../../core/sessions/run-record-io.js';
import { seatIdentitiesFromConfig, seatIdentityChanges } from '../../../core/state/seats.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { hydrateFromState } from '../../../stores/workflow/actions/hydrate.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { resetMarkdownConversationRowsCache } from '../conversation-rows/markdown-rows.js';
import { resetConversationRowsProjectionCache } from '../conversation-rows/projection-cache.js';
import { resetEventBlockCache } from '../conversation-rows/block-cache.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { configStore } from '../../../stores/project/config.js';
import { sessionsStore } from '../../../stores/project/sessions.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import { runWorkflow } from '../../../engine/orchestrator/run/workflow.js';
import { fileHaltIsStale } from '../../../engine/orchestrator/run/init.js';
import {
  applyOfferedSeatSwap,
  type SeatSwapChoice,
} from '../../../engine/orchestrator/run/seat-swap.js';
import { createRecoveryBus } from '../../../engine/orchestrator/recovery/bus.js';
import {
  WORKFLOW_CANCEL_REASON_USER,
  WORKFLOW_USER_CANCELLED_ABORT_REASON,
} from '../../../engine/events/workflow-cancel.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../../../engine/orchestrator/types.js';
import { addTuiEvent } from '../tui-sink.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import type { StreamingSink } from '../../../engine/orchestrator/task/streaming-feed.js';
import type { PreparedExecution } from '../../../engine/runners/prepared-execution.js';
import { prepareExecution } from '../../../engine/runners/prepare-execution/prepare-execution.js';
import { readinessBlockerMessage } from '../../../core/readiness/format.js';
import {
  createAbortHandlerScope,
  setCancelHandler,
  setStopHandler,
  setClearQueueHandler,
  setQueueHandler,
  setResumeHandler,
  setRewindHandler,
  clearAllHandlers,
  cancelBoundaryPause,
  consumeBoundaryInterrupt,
  consumeBoundaryPause,
  consumeSeatChange,
  requestSeatChangeAtBoundary,
} from '../handlers.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { markWorkflowPaused } from '../../../stores/workflow/actions/pause.js';
import { parkStoppedRun } from '../../../engine/orchestrator/state-ops.js';
import { closeRunIfOpen } from '../../../engine/orchestrator/run/close.js';
import { deriveRunStatus } from '../../../core/sessions/run-status.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import {
  onProcessRegistryChange,
  registeredProcessCount,
  killAllProcesses,
} from '../../../lib/process/registry.js';
import { closeApprovalPrompt } from '../../../stores/approval-prompt/prompt.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';
import { nowIso } from '../../../utils/format-time.js';
import type { UseInputModeResult } from './use-input-mode.js';
import { buildPromptCallbacks } from '../prompt-callbacks.js';
import { createRecoveryDriver } from '../recovery-driver.js';
import { runResumePolicy } from '../resume-policy.js';
import { finalizeEndedRun } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { hydrateResume, resumeFailureMessage } from '../resume-hydration.js';
import { clearSessionScopedStores } from '../session-stores.js';
import { type PendingRewind, buildRewindHandler } from '../rewind-handler.js';
import type { UseRunContinueResult } from './use-run-continue.js';

export type RunWorkflowFn = typeof runWorkflow;
export type PrepareExecutionFn = typeof prepareExecution;

function isWorkflowAborted(controller: AbortController, ref: { current: boolean }): boolean {
  return controller.signal.aborted || ref.current;
}

interface UseRunLoopOptions {
  prepared?: PreparedExecution | undefined;
  /** What the operator typed to continue this run; it seeds the first step of this re-entry. */
  steer?: string | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  inputMode: UseInputModeResult;
  /** How this run is re-entered — the loop reads its state and the rewind path restarts through it. */
  continuation: UseRunContinueResult;
  runWorkflow?: RunWorkflowFn | undefined;
  prepareExecution?: PrepareExecutionFn | undefined;
  /**
   * The path a bare ⏎ takes on a run at rest: re-prepare it from the saved config and re-enter it in
   * place. A run that stopped itself at a brief boundary to pick up a changed seat continues here.
   */
  continueAtRest?: ((record: RunRecord) => void) | undefined;
}

interface UseRunLoopResult {
  startedAt: string;
  sessionId?: string | undefined;
}

/**
 * The run itself: one `runWorkflow` call per turn, the recovery panel between
 * turns, and the process-registry watcher that keeps the stop byline honest.
 * Everything about re-entering the run lives in `useRunContinue`.
 */
export function useRunLoop({
  prepared,
  steer,
  selectedSkills,
  inputMode,
  continuation,
  runWorkflow: runWorkflowFn = runWorkflow,
  prepareExecution: prepareExecutionFn = prepareExecution,
  continueAtRest,
}: UseRunLoopOptions): UseRunLoopResult {
  const abortedRef = useRef(false);
  const pendingRewindRef = useRef<PendingRewind | null>(null);
  const [startedAt] = useState(() => nowIso());
  const { runId, inlineResume, setInlineResume, restart, handleResume } = continuation;

  const inlineForPrepared =
    inlineResume !== undefined && inlineResume.prepared === prepared ? inlineResume : undefined;
  const inlineState = inlineForPrepared?.state;

  const startWorkflow = useEffectEvent(async (controller: AbortController) => {
    if (prepared === undefined) return;
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
    };
    let stateForRun = inlineState;
    // The steer belongs to the first call this re-entry makes; the recovery loop's
    // later iterations are the run continuing, not the operator continuing it.
    let steerForRun = inlineForPrepared?.steer ?? steer;
    if (stateForRun === undefined && prepared.runtime.resumeState !== undefined) {
      const hydrated = hydrateResume(session.ref);
      if (hydrated.kind === 'invalid') {
        inputMode.resetMode();
        clearSessionScopedStores();
        addTuiEvent({
          type: 'error',
          ts: Date.now(),
          phase: lifecycleStore.get().phase,
          message: resumeFailureMessage(hydrated),
        });
        return;
      }
      if (hydrated.kind === 'missing') {
        inputMode.resetMode();
        clearSessionScopedStores();
        return;
      }
      stateForRun = hydrated.state;
    }
    const pendingRewind = pendingRewindRef.current;
    pendingRewindRef.current = null;
    let recoveryPromptAlreadyPublished = false;

    // A fresh run starts from an empty screen; a run this screen is continuing already has its
    // history on it, replayed at the navigation event or appended by its earlier passes, and the
    // live bus appends from here. Either way the saved state is laid over the stores, so the brief
    // list and the spend are the run's. A stop that parked the run before belongs to the pass it
    // ended; the pass starting here is live and stops afresh.
    if (stateForRun === undefined) resetWorkflow();
    if (stateForRun !== undefined) {
      stopStore.reset();
      hydrateFromState(stateForRun);
    }
    resetMarkdownConversationRowsCache();
    resetConversationRowsProjectionCache();
    resetEventBlockCache();
    if (pendingRewind?.prepared === prepared) {
      addTuiEvent(pendingRewind.event);
    }
    conversationScrollStore.reset();
    setStopHandler(() => {
      controller.abort();
      inputMode.resetMode();
      closeApprovalPrompt();
      stopStore.get().parked?.resolve?.('');
    });
    setCancelHandler(() => {
      controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
      inputMode.resetMode();
      closeApprovalPrompt();
      stopStore.get().parked?.resolve?.('');
    });
    setRewindHandler(
      buildRewindHandler({
        prepared,
        controller,
        hydrate: hydrateResume,
        resetMode: () => inputMode.resetMode(),
        setPendingRewind: (pending) => {
          pendingRewindRef.current = pending;
        },
        onRewound: (next) => {
          restart({ prepared, state: next });
        },
      }),
    );

    // A re-entry re-prepares this session, and every later iteration belongs to the preparation
    // it made: the seats were built from it, and its receipt is the one on disk — otherwise the
    // next halt rebuilds the tool that hit its limit, and a stop releases a receipt already gone.
    let preparedForRun = prepared;

    const finishStoppedRun = async (): Promise<void> => {
      await killAllProcesses();
      const hydrated = hydrateResume(session.ref);
      if (hydrated.kind !== 'loaded')
        throw error(
          'stop-state-unavailable',
          'Cannot save stopped run: workflow state is unavailable',
        );
      const current = hydrated.state;
      const intent = stopStore.get().intent;
      const closure = intent === 'end-run' ? closeRunIfOpen(session.ref, current) : undefined;
      const status = deriveRunStatus({
        state: current,
        liveness: 'not-alive',
      });
      const next =
        closure !== undefined
          ? closure.state
          : status.kind === 'closed'
            ? current
            : current.pendingRecovery !== undefined
              ? // A halt is not a cut step: the panel owns what happens next.
                current
              : parkStoppedRun(
                  { ...session.ref, bus: createRecoveryBus({ ...session.ref, sink: addTuiEvent }) },
                  current,
                );
      if (closure?.closedNow) {
        createRecoveryBus({ ...session.ref, sink: addTuiEvent }).publish({
          type: 'workflow_cancelled',
          ts: Date.now(),
          phase: next.phase,
          reason: WORKFLOW_CANCEL_REASON_USER,
        });
      }
      finalizeEndedRun({
        ref: session.ref,
        active: preparedForRun.session.active,
        config: preparedForRun.config,
        state: next,
        modelCache: modelCacheStore,
      });
      settleRun(session.ref);
    };

    // A seat saved under the running brief is picked up at the next brief boundary: the run
    // stops itself there instead of parking, and continues the way a run at rest does, re-prepared
    // from the saved config. The panel's own swap re-prepares at once and cancels the request.
    const offConfig = configStore.subscribe(() => {
      const config = configStore.get().config;
      if (config === null || lifecycleStore.get().status !== 'running') return;
      const changed = seatIdentityChanges(
        seatIdentitiesFromConfig(preparedForRun.config),
        seatIdentitiesFromConfig(config),
      );
      if (changed.length > 0) requestSeatChangeAtBoundary();
    });
    let seatChangedAtBoundary = false;
    const promptCallbacks = buildPromptCallbacks({ inputMode, abortedRef, controller });
    const callbacks: OrchestratorCallbacks = {
      ...promptCallbacks,
      onContinuationNeeded: async (partial, at) => {
        if (at === 'boundary' && consumeSeatChange()) {
          seatChangedAtBoundary = true;
          controller.abort();
          return '';
        }
        return (await promptCallbacks.onContinuationNeeded?.(partial, at)) ?? '';
      },
    };

    try {
      let retryProfileOverride: string | undefined;
      let retryProfileOverrideTaskId: TaskId | undefined;
      let switchSeat: SeatSwapChoice | undefined;
      // A halt about files the operator has since put back is not a question any more: on this
      // re-entry it travels into the engine, which resolves it and says so in the transcript.
      // Asked once — a halt this run raises later is fresh by construction.
      let staleHalt =
        stateForRun?.pendingRecovery !== undefined &&
        (await fileHaltIsStale({
          projectDir: session.ref.projectDir,
          state: stateForRun,
          sessionId: session.ref.sessionId,
        }));
      while (!isWorkflowAborted(controller, abortedRef)) {
        if (stateForRun?.pendingRecovery !== undefined && !staleHalt) {
          const promptPendingRecovery = createRecoveryDriver({
            prepared: preparedForRun,
            inputMode,
            abortedRef,
            sink: addTuiEvent,
            setInlineResume: (state) => setInlineResume({ prepared, state }),
          });
          const recovery = await promptPendingRecovery({
            state: stateForRun,
            controller,
            republishPrompt: !recoveryPromptAlreadyPublished,
            correction: steerForRun,
          }).catch((err: unknown) => {
            if (controller.signal.aborted && err === WORKFLOW_USER_CANCELLED_ABORT_REASON)
              return { shouldRun: false as const, state: stateForRun };
            throw err;
          });
          if (controller.signal.aborted) {
            if (!abortedRef.current) await finishStoppedRun();
            return;
          }
          recoveryPromptAlreadyPublished = false;
          if (!recovery.shouldRun) {
            // Ending a run from the recovery panel never re-enters the engine, so
            // the session record is written here through the normal finalize.
            const closedState = recovery.state;
            if (closedState?.closed !== undefined) {
              finalizeEndedRun({
                ref: preparedForRun.session.ref,
                active: preparedForRun.session.active,
                config: preparedForRun.config,
                state: closedState,
                modelCache: modelCacheStore,
              });
            }
            settleRun(session.ref);
            return;
          }
          stateForRun = recovery.state;
          retryProfileOverride = recovery.retryProfileOverride;
          retryProfileOverrideTaskId = recovery.retryProfileOverrideTaskId;
          switchSeat = recovery.switchSeat;
          steerForRun =
            recovery.correctionTaken === true ? undefined : (recovery.steer ?? steerForRun);
        }

        staleHalt = false;

        // A taken seat swap resolves the halt onto the new tool and prepares this session on it.
        // That is this re-entry's preparation: the seat that halted is not admitted again, so a
        // tool that can no longer run cannot block the move away from it.
        if (switchSeat !== undefined && stateForRun !== undefined) {
          const swapped = await applyOfferedSeatSwap({
            choice: switchSeat,
            projectDir: session.ref.projectDir,
            sessionId: session.ref.sessionId,
            bus: createRecoveryBus({ ...session.ref, sink: addTuiEvent }),
            config: preparedForRun.config,
            prepared: preparedForRun,
            savedState: stateForRun,
            signal: controller.signal,
            prepare: prepareExecutionFn,
            onSeatSwapped: (swappedPrepared) => {
              preparedForRun = swappedPrepared;
              if (consumeSeatChange()) cancelBoundaryPause();
            },
          });
          switchSeat = undefined;
          if (controller.signal.aborted) {
            if (!abortedRef.current) await finishStoppedRun();
            return;
          }
          if (swapped !== undefined) stateForRun = swapped.state;
        }

        // A run started here was prepared to allocate its session, and that preparation starts a
        // session only once. Every later entry continues the session, so it is admitted again as a
        // resume before it re-enters the engine.
        if (preparedForRun.purpose === 'new-workflow' && stateForRun !== undefined) {
          const reprepared = await prepareExecutionFn({
            existingSession: session.ref,
            feature: stateForRun.feature,
            effectiveConfig: preparedForRun.config,
            policy: runResumePolicy(preparedForRun),
            signal: controller.signal,
            resumeState: stateForRun,
          });
          if (reprepared.kind === 'aborted') {
            if (!abortedRef.current) await finishStoppedRun();
            return;
          }
          if (reprepared.kind !== 'prepared') {
            addTuiEvent({
              type: 'error',
              ts: Date.now(),
              phase: lifecycleStore.get().phase,
              message:
                reprepared.kind === 'blocked'
                  ? `Cannot resume: ${readinessBlockerMessage(reprepared.report)}`
                  : `Cannot resume: ${toErrorMessage(reprepared.error)}`,
            });
            settleRun(session.ref);
            return;
          }
          preparedForRun = reprepared.execution;
        }

        const storeStreamingSink: StreamingSink = {
          start: (tid) => streamingOutputStore.startStreaming(tid),
          replaceLines: (lines) => streamingOutputStore.replaceLines(lines),
          stop: () => streamingOutputStore.stopStreaming(),
        };

        const detectedContextLength = configStore.getDetectedContextLength();
        await runWorkflowFn({
          prepared: preparedForRun,
          getApprovalEnabled: () => configStore.get().config?.approval?.enabled !== false,
          sinks,
          tuiSink: addTuiEvent,
          modelCache: modelCacheStore,
          drainPendingAttachments: () => attachmentsStore.drain(),
          streamingSink: storeStreamingSink,
          signal: controller.signal,
          callbacks,
          savedState: stateForRun,
          selectedSkills,
          ...(steerForRun !== undefined && { steer: steerForRun }),
          ...(detectedContextLength !== undefined && { detectedContextLength }),
          ...(retryProfileOverride !== undefined && { retryProfileOverride }),
          ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
        });
        retryProfileOverride = undefined;
        retryProfileOverrideTaskId = undefined;
        steerForRun = undefined;

        if (abortedRef.current) return;
        if (controller.signal.aborted) {
          if (stopStore.get().intent === 'end-run') await finishStoppedRun();
          else if (seatChangedAtBoundary) {
            stopStore.reset();
            continueAtRest?.(settleRun(session.ref));
          } else settleRun(session.ref);
          return;
        }

        const hydrated = hydrateResume(session.ref);
        if (hydrated.kind === 'invalid') {
          inputMode.resetMode();
          clearSessionScopedStores();
          addTuiEvent({
            type: 'error',
            ts: Date.now(),
            phase: lifecycleStore.get().phase,
            message: resumeFailureMessage(hydrated),
          });
          settleRun(session.ref);
          return;
        }
        const saved = hydrated.kind === 'loaded' ? hydrated.state : null;

        // A halt is the only thing that keeps this loop turning: the recovery panel runs in this
        // process, answers, and re-enters the engine. Every other return is the run at rest, and
        // the screen it is already on paints it from its re-read record.
        if (!saved?.pendingRecovery) {
          settleRun(session.ref);
          return;
        }

        stateForRun = saved;
        setInlineResume({ prepared, state: saved });
        recoveryPromptAlreadyPublished = true;
      }
    } catch (err) {
      if (abortedRef.current) return;
      const message = toErrorMessage(err);
      addTuiEvent({ type: 'error', ts: Date.now(), phase: lifecycleStore.get().phase, message });
      if (stopStore.get().intent !== 'none') {
        stopStore.fail(message);
        // Retry only cleanup and persistence, never the interrupted model call.
        setStopHandler(() => {
          void (async () => {
            try {
              await finishStoppedRun();
            } catch (retryError) {
              stopStore.fail(toErrorMessage(retryError));
            }
          })();
        });
        overlayStore.open('stop-sheet');
      } else {
        settleRun(session.ref);
      }
    } finally {
      offConfig();
    }
  });

  useEffect(() => {
    if (prepared === undefined) return undefined;

    abortedRef.current = false;
    const controller = new AbortController();
    setResumeHandler((text) => handleResume(text));
    void startWorkflow(controller);
    return () => {
      abortedRef.current = true;
      inputMode.resetMode();
      controller.abort();
      clearAllHandlers();
      closeApprovalPrompt();
    };
  }, [prepared, runId]);

  useEffect(() => {
    const update = () => {
      const { intent, phase } = stopStore.get();
      if (
        intent === 'none' ||
        intent === 'pause-after-brief' ||
        phase === 'parked' ||
        phase === 'ended' ||
        phase === 'failed'
      )
        return;
      if (registeredProcessCount() > 0) {
        if (phase !== 'terminating') stopStore.markTerminating();
      } else if (phase !== 'settling') stopStore.markSettling();
    };
    const offProcesses = onProcessRegistryChange(update);
    const offStop = stopStore.subscribe(update);
    update();
    return () => {
      offProcesses();
      offStop();
    };
  }, []);

  // The run loop returned: the run is at rest, on the screen it never left. One re-read of the
  // record is the whole hand-off — the screen paints open or closed from it, and the session list
  // shows what it shows everywhere else.
  const settleRun = (ref: PreparedExecution['session']['ref']): RunRecord => {
    const record = readRunRecord(ref);
    const wasStopping = stopStore.get().intent !== 'none';
    setStopHandler(null);
    setCancelHandler(null);
    inputMode.resetMode();
    routerStore.updateRun({ run: record, execution: { kind: 'at-rest' } });
    sessionsStore.refresh();
    if (wasStopping) {
      if (record.status.kind === 'closed') stopStore.end();
      else {
        markWorkflowPaused();
        stopStore.park('mid-brief', null, null);
      }
      // A queued leave/quit is delivered by the stop observer before offering actions here. A run
      // whose final review passed before the stop reached it is complete, not stopped: the stop then
      // stands down, and the closed run's own byline speaks for it.
      if (record.status.kind === 'closed' && record.status.as === 'complete') {
        stopStore.reset();
        // End run marks the lifecycle cancelled at the keypress, and no later event lifts that
        // mark; the record says the run completed, and the record wins.
        if (record.hydration.kind === 'loaded') hydrateFromState(record.hydration.state);
      } else if (routerStore.get().screen === 'workflow' && overlayStore.get().active === 'none')
        overlayStore.open('stop-sheet');
    }
    return record;
  };

  return { startedAt, sessionId: prepared?.session.ref.sessionId };
}
