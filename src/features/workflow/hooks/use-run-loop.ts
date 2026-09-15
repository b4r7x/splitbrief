import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { TaskId } from '../../../core/schemas/task.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import { readRunRecord } from '../../../core/sessions/run-record-io.js';
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
import type { SeatSwapChoice } from '../../../engine/orchestrator/run/seat-swap.js';
import { WORKFLOW_USER_CANCELLED_ABORT_REASON } from '../../../engine/events/workflow-cancel.js';
import type { WorkflowSinks } from '../../../engine/orchestrator/types.js';
import { addTuiEvent } from '../tui-sink.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import type { StreamingSink } from '../../../engine/orchestrator/task/streaming-feed.js';
import type { PreparedExecution } from '../../../engine/runners/prepared-execution.js';
import {
  createAbortHandlerScope,
  setCancelHandler,
  setClearQueueHandler,
  setQueueHandler,
  setResumeHandler,
  setRewindHandler,
  clearAllHandlers,
  consumeBoundaryInterrupt,
  consumeBoundaryPause,
} from '../handlers.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { onProcessRegistryChange, SIGKILL_DELAY_MS } from '../../../lib/process/registry.js';
import { closeApprovalPrompt } from '../../../stores/approval-prompt/prompt.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import type { UseInputModeResult } from './use-input-mode.js';
import { buildPromptCallbacks } from '../prompt-callbacks.js';
import { createRecoveryDriver } from '../recovery-driver.js';
import { finalizeEndedRun } from '../../../engine/orchestrator/session-lifecycle/finalize.js';
import { hydrateResume, resumeFailureMessage } from '../resume-hydration.js';
import { clearSessionScopedStores } from '../session-stores.js';
import { type PendingRewind, buildRewindHandler } from '../rewind-handler.js';
import type { UseRunContinueResult } from './use-run-continue.js';

export type RunWorkflowFn = typeof runWorkflow;

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
    const rewindFeedbackForRun =
      pendingRewind?.prepared === prepared ? pendingRewind.feedback : undefined;
    pendingRewindRef.current = null;
    let recoveryPromptAlreadyPublished = false;

    // A fresh run starts from an empty screen; a run this screen is continuing already has its
    // history on it, replayed at the navigation event, and the live bus appends from here. Either
    // way the saved state is laid over the stores, so the brief list and the spend are the run's.
    if (prepared.purpose === 'new-workflow') resetWorkflow();
    if (stateForRun !== undefined) hydrateFromState(stateForRun);
    resetMarkdownConversationRowsCache();
    resetConversationRowsProjectionCache();
    resetEventBlockCache();
    if (pendingRewind?.prepared === prepared) {
      addTuiEvent(pendingRewind.event);
    }
    conversationScrollStore.reset();
    setCancelHandler(() => {
      inputMode.resetMode();
      controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
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

    try {
      let retryProfileOverride: string | undefined;
      let retryProfileOverrideTaskId: TaskId | undefined;
      let switchSeat: SeatSwapChoice | undefined;
      // A taken seat swap re-prepares this session, and every later iteration belongs to
      // the preparation the seats were actually built from — otherwise the next halt
      // rebuilds the tool that hit its limit.
      let preparedForRun = prepared;
      while (!isWorkflowAborted(controller, abortedRef)) {
        if (stateForRun?.pendingRecovery !== undefined) {
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
          });
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
          callbacks: buildPromptCallbacks({ inputMode, abortedRef, controller }),
          savedState: stateForRun,
          selectedSkills,
          ...(steerForRun !== undefined && { steer: steerForRun }),
          ...(rewindFeedbackForRun !== undefined && { rewindFeedback: rewindFeedbackForRun }),
          ...(detectedContextLength !== undefined && { detectedContextLength }),
          ...(retryProfileOverride !== undefined && { retryProfileOverride }),
          ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
          ...(switchSeat !== undefined && { switchSeat }),
          onSeatSwapped: (swappedPrepared) => {
            preparedForRun = swappedPrepared;
          },
        });
        retryProfileOverride = undefined;
        retryProfileOverrideTaskId = undefined;
        switchSeat = undefined;
        steerForRun = undefined;

        if (isWorkflowAborted(controller, abortedRef)) return;

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
      if (!isWorkflowAborted(controller, abortedRef) && !lifecycleStore.get().cancelled) {
        addTuiEvent({
          type: 'error',
          ts: Date.now(),
          phase: lifecycleStore.get().phase,
          message: toErrorMessage(err),
        });
      }
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

  // The stop byline names what the processes are actually doing, so it follows the registry rather
  // than a guess: alive after a request is terminating, still alive past the grace is forcing.
  useEffect(() => {
    let forceTimer: ReturnType<typeof setTimeout> | null = null;
    const clearForceTimer = () => {
      if (forceTimer === null) return;
      clearTimeout(forceTimer);
      forceTimer = null;
    };
    const off = onProcessRegistryChange((count) => {
      const { intent, phase } = stopStore.get();
      if (intent === 'none') return;
      if (count > 0) {
        if (phase !== 'requested') return;
        stopStore.markTerminating();
        forceTimer = setTimeout(() => stopStore.markForcing(), SIGKILL_DELAY_MS);
        return;
      }
      clearForceTimer();
      // Stop now and a boundary pause both end at a park the engine owns; only a run that was told
      // to end is over the moment its processes are.
      if (intent !== 'end-run' && intent !== 'quit') return;
      if (phase === 'terminating' || phase === 'forcing') stopStore.end();
    });
    return () => {
      clearForceTimer();
      off();
    };
  }, []);

  // The run loop returned: the run is at rest, on the screen it never left. One re-read of the
  // record is the whole hand-off — the screen paints open or closed from it, and the session list
  // shows what it shows everywhere else.
  const settleRun = (ref: PreparedExecution['session']['ref']): void => {
    routerStore.updateRun({ run: readRunRecord(ref), execution: { kind: 'at-rest' } });
    sessionsStore.refresh();
  };

  return { startedAt, sessionId: prepared?.session.ref.sessionId };
}
