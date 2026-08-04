import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { Session } from '../../../core/schemas/session.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { resetMarkdownConversationRowsCache } from '../conversation-rows/markdown-rows.js';
import { resetConversationRowsProjectionCache } from '../conversation-rows/projection-cache.js';
import { resetEventBlockCache } from '../conversation-rows/block-cache.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { configStore } from '../../../stores/project/config.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import {
  runWorkflow,
  WORKFLOW_REWIND_ABORT_REASON,
} from '../../../engine/orchestrator/run/workflow.js';
import {
  WORKFLOW_USER_CANCELLED_ABORT_REASON,
  type WorkflowSinks,
} from '../../../engine/orchestrator/types.js';
import { addTuiEvent, createTuiSink } from '../tui-sink.js';
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
import { loadState, saveState } from '../../../core/state/persistence.js';
import { readSession } from '../../../core/sessions/io.js';
import { transition } from '../../../core/state/machine.js';
import { isResumable } from '../../../core/phases.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import type { UseInputModeResult } from './use-input-mode.js';
import { buildRewindAction } from '../../../core/state/build-rewind-action.js';
import { buildPromptCallbacks } from '../prompt-callbacks.js';
import { createRecoveryDriver } from '../recovery-driver.js';
import { enqueueUserMessage } from '../../../engine/orchestrator/queue/submit.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { createJsonlSink } from '../../../engine/events/sinks/jsonl.js';

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

interface PendingRewind {
  prepared: PreparedExecution;
  event: EngineEvent;
  feedback: string | undefined;
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

  const resumeState =
    inlineResume !== undefined && inlineResume.prepared === prepared
      ? inlineResume.state
      : prepared?.runtime.resumeState;

  const buildCallbacks = buildPromptCallbacks();
  const recoveryDriverFactory = createRecoveryDriver();

  const startWorkflow = useEffectEvent(async (controller: AbortController) => {
    if (prepared === undefined) return;
    const { session, config } = prepared;
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
    let stateForRun = resumeState;
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
      addTuiEvent(pendingRewind.event, {
        persistTranscript: config.workflow.persistTranscript,
      });
    }
    conversationScrollStore.reset();
    setCancelHandler(() => {
      inputMode.resetMode();
      controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
    });
    setRewindHandler((request) => {
      inputMode.resetMode();
      const ref = session.ref;
      const current = loadState(ref);
      if (!current) return;

      const { action, persistedAction, event } = buildRewindAction({
        request,
        ref,
        state: current,
        persistTranscript: config.workflow.persistTranscript,
      });
      let next = transition(current, persistedAction);
      if (request.target === 'task' && next.pendingRecovery?.taskId === request.taskId) {
        next = transition(next, { type: 'RESOLVE_PENDING_RECOVERY' });
      }
      saveState(ref, next);
      pendingRewindRef.current = {
        prepared,
        event,
        feedback:
          action.type === 'REWIND_TO_SPEC' || action.type === 'REWIND_TO_PLAN'
            ? action.comment
            : undefined,
      };
      controller.abort(WORKFLOW_REWIND_ABORT_REASON);
      setInlineResume({ prepared, state: next });
      setRunId((id) => id + 1);
    });

    try {
      let retryProfileOverride: string | undefined;
      let retryProfileOverrideTaskId: TaskId | undefined;
      while (!isWorkflowAborted(controller, abortedRef)) {
        const promptPendingRecovery = recoveryDriverFactory({
          prepared,
          inputMode,
          abortedRef,
          setInlineResume: (state) => setInlineResume({ prepared, state }),
        });
        if (stateForRun?.pendingRecovery) {
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
        }

        const storeStreamingSink: StreamingSink = {
          start: (tid) => streamingOutputStore.startStreaming(tid),
          replaceLines: (lines) => streamingOutputStore.replaceLines(lines),
          stop: () => streamingOutputStore.stopStreaming(),
        };

        const detectedContextLength = configStore.getDetectedContextLength();
        const summary = await runWorkflowFn({
          prepared,
          getApprovalEnabled: () => configStore.get().config?.approval?.enabled !== false,
          sinks,
          tuiSink: createTuiSink({ persistTranscript: config.workflow.persistTranscript }),
          modelCache: modelCacheStore,
          drainPendingAttachments: () => attachmentsStore.drain(),
          streamingSink: storeStreamingSink,
          signal: controller.signal,
          callbacks: buildCallbacks({
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
        });
        retryProfileOverride = undefined;
        retryProfileOverrideTaskId = undefined;

        if (isWorkflowAborted(controller, abortedRef)) return;

        const persistedSession = readSession(session.ref);
        if (persistedSession?.status === 'failed') {
          onComplete({ summary, sessionId, status: 'failed' });
          return;
        }

        const saved = loadState(session.ref);

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
        addTuiEvent(
          {
            type: 'error',
            ts: Date.now(),
            phase: lifecycleStore.get().phase,
            message: toErrorMessage(err),
          },
          { persistTranscript: config.workflow.persistTranscript },
        );
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
    const { session, config } = prepared;
    const { projectDir, sessionId } = session.ref;
    const saved = loadState(session.ref);
    if (!saved) {
      feedbackStore.setError('No saved state to resume. Press esc to return home.');
      return;
    }
    if (!isResumable(saved)) {
      feedbackStore.setError(
        'This cancelled workflow cannot be resumed. Press esc to return home.',
      );
      return;
    }
    const persistTranscript = config.workflow.persistTranscript;
    const text = injectedText?.trim();
    let next = saved;
    if (text) {
      const bus = createEventBus();
      bus.subscribe(
        createJsonlSink({
          projectDir,
          sessionId,
          persistTranscript,
        }),
      );
      bus.subscribe(createTuiSink({ persistTranscript }));
      const queued = enqueueUserMessage({
        projectDir,
        sessionId,
        state: saved,
        text,
        phase: saved.phase,
        bus,
        persistTranscript: persistTranscript !== false,
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
