import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { Config } from '../../../core/schemas/config.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { Session } from '../../../core/schemas/session.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import { resetWorkflow } from '../../../stores/workflow/actions.js';
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
import {
  createAbortHandlerScope,
  setCancelHandler,
  setClearQueueHandler,
  setQueueHandler,
  setRewindHandler,
  clearAllHandlers,
  consumeBoundaryInterrupt,
} from '../handlers.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { closeApprovalPrompt } from '../../../stores/approval-prompt/prompt.js';
import { closeCostApprovalPrompt } from '../../../stores/cost-approval/prompt.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { generateSessionId, readActive } from '../../../core/sessions/lifecycle.js';
import { configForSessionTranscriptPolicy, readSession } from '../../../core/sessions/io.js';
import { transition } from '../../../core/state/machine.js';
import { isResumable } from '../../../core/phases.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import type { UseInputModeResult } from './use-input-mode.js';
import { buildRewindAction } from '../../../core/state/build-rewind-action.js';
import { buildPromptCallbacks } from '../prompt-callbacks.js';
import { createRecoveryDriver } from '../recovery-driver.js';
import { enqueueUserMessage } from '../../../engine/orchestrator/queue.js';
import { createEventBus } from '../../../engine/events/bus.js';
import { createJsonlSink } from '../../../engine/events/sinks/jsonl.js';

export type RunWorkflowFn = typeof runWorkflow;

function isWorkflowAborted(controller: AbortController, ref: { current: boolean }): boolean {
  return controller.signal.aborted || ref.current;
}

interface UseWorkflowRunnerOptions {
  feature: string;
  plannerContext?: string | undefined;
  projectDir: string;
  config: Config;
  onComplete: (completion: WorkflowCompletion) => void;
  initialResumeState?: WorkflowState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  inputMode: UseInputModeResult;
  sessionId?: string | undefined;
  allowRepoRunners?: boolean | undefined;
  enabled?: boolean | undefined;
  runWorkflow?: RunWorkflowFn | undefined;
}

export interface WorkflowCompletion {
  summary: Summary;
  sessionId: string;
  status: Session['status'];
}

interface UseWorkflowRunnerResult {
  startedAt: string;
  sessionId?: string | undefined;
  handleResume: (injectedText?: string) => void;
}

export function useWorkflowRunner({
  feature,
  plannerContext,
  projectDir,
  config,
  onComplete,
  initialResumeState,
  selectedSkills,
  inputMode,
  sessionId: initialSessionId,
  allowRepoRunners = false,
  enabled = true,
  runWorkflow: runWorkflowFn = runWorkflow,
}: UseWorkflowRunnerOptions): UseWorkflowRunnerResult {
  const abortedRef = useRef(false);
  const pendingRewindEventRef = useRef<EngineEvent | null>(null);
  const pendingRewindFeedbackRef = useRef<string | undefined>(undefined);
  const sessionIdRef = useRef<string | undefined>(initialSessionId);
  const [startedAt] = useState(() => nowIso());
  const [runId, setRunId] = useState(0);
  const [inlineResume, setInlineResume] = useState<WorkflowState | undefined>(undefined);

  const resumeState = inlineResume ?? initialResumeState;

  const buildCallbacks = buildPromptCallbacks();
  const recoveryDriverFactory = createRecoveryDriver();

  const startWorkflow = useEffectEvent(async (controller: AbortController) => {
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
    const rewindFeedbackForRun = pendingRewindFeedbackRef.current;
    pendingRewindFeedbackRef.current = undefined;
    if (initialSessionId) sessionIdRef.current = initialSessionId;
    const pendingRecoverySessionId = stateForRun?.pendingRecovery
      ? (readActive(projectDir) ?? undefined)
      : undefined;
    const sessionIdForRun =
      sessionIdRef.current ??
      pendingRecoverySessionId ??
      generateSessionId(projectDir, feature, new Date(), {
        persistTranscript: config.workflow.persistTranscript,
      });
    sessionIdRef.current = sessionIdForRun;
    let activeSessionId = sessionIdForRun;
    let recoveryPromptAlreadyPublished = false;

    function activeConfig(): Config {
      return configForSessionTranscriptPolicy(config, { projectDir, sessionId: activeSessionId });
    }

    resetWorkflow(stateForRun);
    resetMarkdownConversationRowsCache();
    resetConversationRowsProjectionCache();
    resetEventBlockCache();
    if (pendingRewindEventRef.current) {
      addTuiEvent(pendingRewindEventRef.current, {
        persistTranscript: activeConfig().workflow.persistTranscript,
      });
      pendingRewindEventRef.current = null;
    }
    conversationScrollStore.reset();
    setCancelHandler(() => {
      inputMode.resetMode();
      controller.abort(WORKFLOW_USER_CANCELLED_ABORT_REASON);
    });
    setRewindHandler((request) => {
      inputMode.resetMode();
      const ref = { projectDir, sessionId: activeSessionId };
      const effectiveConfig = activeConfig();
      const current = loadState(ref);
      if (!current) return;

      const { action, persistedAction, event } = buildRewindAction({
        request,
        ref,
        state: current,
        persistTranscript: effectiveConfig.workflow.persistTranscript,
      });
      let next = transition(current, persistedAction);
      if (request.target === 'task' && next.pendingRecovery?.taskId === request.taskId) {
        next = transition(next, { type: 'RESOLVE_PENDING_RECOVERY' });
      }
      saveState(ref, next);
      pendingRewindFeedbackRef.current =
        action.type === 'REWIND_TO_SPEC' || action.type === 'REWIND_TO_PLAN'
          ? action.comment
          : undefined;
      pendingRewindEventRef.current = event;
      controller.abort(WORKFLOW_REWIND_ABORT_REASON);
      setInlineResume(next);
      setRunId((id) => id + 1);
    });

    try {
      let retryProfileOverride: string | undefined;
      let retryProfileOverrideTaskId: TaskId | undefined;
      while (!isWorkflowAborted(controller, abortedRef)) {
        const effectiveConfig = activeConfig();
        const promptPendingRecovery = recoveryDriverFactory({
          projectDir,
          config: effectiveConfig,
          inputMode,
          abortedRef,
          setInlineResume,
        });
        if (stateForRun?.pendingRecovery) {
          const recovery = await promptPendingRecovery({
            state: stateForRun,
            activeSessionId,
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
          feature,
          plannerContext,
          projectDir,
          config: effectiveConfig,
          allowRepoRunners,
          getApprovalEnabled: () => configStore.get().config?.approval?.enabled !== false,
          sinks,
          tuiSink: createTuiSink({ persistTranscript: effectiveConfig.workflow.persistTranscript }),
          modelCache: modelCacheStore,
          drainPendingAttachments: () => attachmentsStore.drain(),
          streamingSink: storeStreamingSink,
          signal: controller.signal,
          callbacks: buildCallbacks({
            inputMode,
            abortedRef,
            controller,
            onComplete: (summary) =>
              onComplete({ summary, sessionId: activeSessionId, status: 'complete' }),
          }),
          savedState: stateForRun,
          selectedSkills,
          sessionId: activeSessionId,
          ...(rewindFeedbackForRun !== undefined && { rewindFeedback: rewindFeedbackForRun }),
          ...(detectedContextLength !== undefined && { detectedContextLength }),
          ...(retryProfileOverride !== undefined && { retryProfileOverride }),
          ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
        });
        retryProfileOverride = undefined;
        retryProfileOverrideTaskId = undefined;

        if (isWorkflowAborted(controller, abortedRef)) return;

        const session = readSession({ projectDir, sessionId: activeSessionId });
        if (session?.status === 'failed') {
          onComplete({ summary, sessionId: activeSessionId, status: 'failed' });
          return;
        }

        const savedSessionId = activeSessionId;
        const saved = savedSessionId ? loadState({ projectDir, sessionId: savedSessionId }) : null;

        // A failed final-review gate returns without onComplete and leaves the phase at
        // 'final-review' (a LIVE_PHASE). Drive the screen to the terminal summary view so
        // the user is not stranded on a live-looking workflow screen.
        if (!saved?.pendingRecovery && saved?.phase === 'final-review') {
          onComplete({ summary, sessionId: savedSessionId, status: 'interrupted' });
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
            onComplete({ summary, sessionId: savedSessionId, status: 'interrupted' });
          }
          return;
        }

        activeSessionId = savedSessionId;
        sessionIdRef.current = savedSessionId;
        stateForRun = saved;
        setInlineResume(saved);
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
          { persistTranscript: activeConfig().workflow.persistTranscript },
        );
      }
    }
  });

  useEffect(() => {
    if (!enabled) return undefined;

    abortedRef.current = false;
    const controller = new AbortController();
    void startWorkflow(controller);
    return () => {
      abortedRef.current = true;
      inputMode.resetMode();
      controller.abort();
      clearAllHandlers();
      killAllProcesses();
      closeApprovalPrompt();
      closeCostApprovalPrompt({ approved: false });
    };
    // config is intentionally excluded from the dep array: config changes mid-workflow
    // should NOT restart the workflow. The latest config is captured via useEffectEvent
    // when startWorkflow fires.
  }, [enabled, feature, projectDir, runId]);

  const handleResume = (injectedText?: string) => {
    const sessionId = sessionIdRef.current ?? readActive(projectDir);
    const saved = sessionId ? loadState({ projectDir, sessionId }) : null;
    if (!saved || !sessionId) {
      feedbackStore.setError('No saved state to resume. Press esc to return home.');
      return;
    }
    if (!isResumable(saved)) {
      feedbackStore.setError(
        'This cancelled workflow cannot be resumed. Press esc to return home.',
      );
      return;
    }
    sessionIdRef.current = sessionId;
    const effectiveConfig = configForSessionTranscriptPolicy(config, { projectDir, sessionId });
    const persistTranscript = effectiveConfig.workflow.persistTranscript;
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
        setInlineResume(next);
        return;
      }
    }
    setInlineResume(next);
    setRunId((id) => id + 1);
  };

  return { startedAt, sessionId: sessionIdRef.current, handleResume };
}
