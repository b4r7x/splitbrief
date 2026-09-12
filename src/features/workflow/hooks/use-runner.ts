import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { Session } from '../../../core/schemas/session.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { resetMarkdownConversationRowsCache } from '../conversation-rows/markdown-rows.js';
import { resetConversationRowsProjectionCache } from '../conversation-rows/projection-cache.js';
import { resetEventBlockCache } from '../conversation-rows/block-cache.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { configStore } from '../../../stores/project/config.js';
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
  setRewindHandler,
  clearAllHandlers,
  consumeBoundaryInterrupt,
} from '../handlers.js';
import { closeApprovalPrompt } from '../../../stores/approval-prompt/prompt.js';
import { closeCostApprovalPrompt } from '../../../stores/cost-approval/prompt.js';
import { readSession } from '../../../core/sessions/io.js';
import { isResumable } from '../../../core/phases.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import type { UseInputModeResult } from './use-input-mode.js';
import { buildPromptCallbacks } from '../prompt-callbacks.js';
import { createRecoveryDriver } from '../recovery-driver.js';
import { enqueueUserMessage } from '../../../engine/orchestrator/queue/submit.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { createJsonlSink } from '../../../engine/events/sinks/jsonl.js';
import { hydrateResume, resumeFailureMessage } from '../resume-hydration.js';
import { clearSessionScopedStores } from '../session-stores.js';
import { type PendingRewind, buildRewindHandler } from '../rewind-handler.js';

export type RunWorkflowFn = typeof runWorkflow;

function isWorkflowAborted(controller: AbortController, ref: { current: boolean }): boolean {
  return controller.signal.aborted || ref.current;
}

interface UseWorkflowRunnerOptions {
  prepared?: PreparedExecution | undefined;
  onComplete: (completion: WorkflowCompletion) => void;
  selectedSkills?: SkillMeta[] | undefined;
  inputMode: UseInputModeResult;
  runWorkflow?: RunWorkflowFn | undefined;
}

export interface WorkflowCompletion {
  summary: Summary;
  sessionId: string;
  status: Session['status'];
}

interface InlineResume {
  prepared: PreparedExecution;
  state: WorkflowState;
}

interface UseWorkflowRunnerResult {
  startedAt: string;
  sessionId?: string | undefined;
  handleResume: (injectedText?: string) => void;
}

export function useWorkflowRunner({
  prepared,
  onComplete,
  selectedSkills,
  inputMode,
  runWorkflow: runWorkflowFn = runWorkflow,
}: UseWorkflowRunnerOptions): UseWorkflowRunnerResult {
  const abortedRef = useRef(false);
  const pendingRewindRef = useRef<PendingRewind | null>(null);
  const [startedAt] = useState(() => nowIso());
  const [runId, setRunId] = useState(0);
  const [inlineResume, setInlineResume] = useState<InlineResume | undefined>(undefined);

  const inlineState =
    inlineResume !== undefined && inlineResume.prepared === prepared
      ? inlineResume.state
      : undefined;

  const startWorkflow = useEffectEvent(async (controller: AbortController) => {
    if (prepared === undefined) return;
    const { session } = prepared;
    const { sessionId } = session.ref;
    // A fresh abort-handler scope per run: a superseded run's late pops (its
    // aborted body settles after the rewind cleanup) drain its own scope and
    // cannot steal this run's live handler.
    const sinks: WorkflowSinks = {
      setAbortHandler: createAbortHandlerScope(),
      setClearQueueHandler,
      setQueueHandler,
      consumeBoundaryInterrupt,
    };
    let stateForRun = inlineState;
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

    resetWorkflow(stateForRun);
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
          setInlineResume({ prepared, state: next });
          setRunId((id) => id + 1);
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
            setInlineResume: (state) => setInlineResume({ prepared, state }),
          });
          const recovery = await promptPendingRecovery({
            state: stateForRun,
            controller,
            republishPrompt: !recoveryPromptAlreadyPublished,
          });
          recoveryPromptAlreadyPublished = false;
          if (!recovery.shouldRun) return;
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
        const summary = await runWorkflowFn({
          prepared: preparedForRun,
          getApprovalEnabled: () => configStore.get().config?.approval?.enabled !== false,
          sinks,
          tuiSink: addTuiEvent,
          modelCache: modelCacheStore,
          drainPendingAttachments: () => attachmentsStore.drain(),
          streamingSink: storeStreamingSink,
          signal: controller.signal,
          callbacks: buildPromptCallbacks({
            inputMode,
            abortedRef,
            controller,
            onComplete: (summary) => onComplete({ summary, sessionId, status: 'complete' }),
          }),
          savedState: stateForRun,
          selectedSkills,
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

        if (isWorkflowAborted(controller, abortedRef)) return;

        const persistedSession = readSession(session.ref);
        if (persistedSession?.status === 'failed') {
          onComplete({ summary, sessionId, status: 'failed' });
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
          return;
        }
        const saved = hydrated.kind === 'loaded' ? hydrated.state : null;

        // A failed final-review gate returns without onComplete and leaves the phase at
        // 'final-review' (a LIVE_PHASE). Drive the screen to the terminal summary view so
        // the user is not stranded on a live-looking workflow screen.
        if (!saved?.pendingRecovery && saved?.phase === 'final-review') {
          onComplete({ summary, sessionId, status: 'interrupted' });
          return;
        }
        if (!saved?.pendingRecovery) {
          // The engine run returned while the lifecycle still says interrupted —
          // e.g. Esc-Esc aborted an approval-gate regeneration, which cancels the
          // planning phase without publishing a cancellation event or parking a
          // continuation prompt. Nothing is parked, so the interrupted byline's
          // Enter-retry promise cannot be kept here; drive to the terminal
          // summary view instead of leaving a dead workflow screen.
          if (lifecycleStore.get().status === 'interrupted') {
            onComplete({ summary, sessionId, status: 'interrupted' });
          }
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
    void startWorkflow(controller);
    return () => {
      abortedRef.current = true;
      inputMode.resetMode();
      controller.abort();
      clearAllHandlers();
      closeApprovalPrompt();
      closeCostApprovalPrompt({ approved: false });
    };
  }, [prepared, runId]);

  const handleResume = (injectedText?: string) => {
    if (prepared === undefined) return;
    const { session } = prepared;
    const { projectDir, sessionId } = session.ref;
    const hydrated = hydrateResume(session.ref);
    if (hydrated.kind === 'missing') {
      inputMode.resetMode();
      clearSessionScopedStores();
      feedbackStore.setError('No saved state to resume. Press esc to return home.');
      return;
    }
    if (hydrated.kind === 'invalid') {
      inputMode.resetMode();
      clearSessionScopedStores();
      feedbackStore.setError(resumeFailureMessage(hydrated));
      return;
    }
    const saved = hydrated.state;
    if (!isResumable(saved)) {
      inputMode.resetMode();
      clearSessionScopedStores();
      feedbackStore.setError(
        'This cancelled workflow cannot be resumed. Press esc to return home.',
      );
      return;
    }
    const text = injectedText?.trim();
    let next = saved;
    if (text) {
      const bus = createEventBus();
      bus.subscribe(
        createJsonlSink({
          projectDir,
          sessionId,
          onDegraded: (warning) => bus.publish(warning),
        }),
      );
      bus.subscribe(addTuiEvent);
      const queued = enqueueUserMessage({
        projectDir,
        sessionId,
        state: saved,
        text,
        phase: saved.phase,
        bus,
        enforcePhasePolicy: false,
      });
      next = queued.state;
      if (queued.result.status === 'rejected') {
        feedbackStore.setError(queued.result.message);
        setInlineResume({ prepared, state: next });
        return;
      }
    }
    setInlineResume({ prepared, state: next });
    setRunId((id) => id + 1);
  };

  return { startedAt, sessionId: prepared?.session.ref.sessionId, handleResume };
}
