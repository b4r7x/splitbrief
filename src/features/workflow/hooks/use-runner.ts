import { randomUUID } from 'node:crypto';
import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { Config } from '../../../core/schemas/config.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import { addEvent, resetWorkflow } from '../../../stores/workflow/actions.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { configStore } from '../../../stores/project/config.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import {
  runWorkflow,
  WORKFLOW_REWIND_ABORT_REASON,
} from '../../../engine/orchestrator/run/workflow.js';
import type { WorkflowSinks } from '../../../engine/orchestrator/types.js';
import { createTuiSink } from '../tui-sink.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import type { StreamingSink } from '../../../engine/orchestrator/task/streaming-feed.js';
import {
  setAbortHandler,
  setCancelHandler,
  setClearQueueHandler,
  setQueueHandler,
  setRewindHandler,
  clearAllHandlers,
} from '../handlers.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { closeApprovalPrompt } from '../../../stores/approval-prompt/prompt.js';
import { closeCostApprovalPrompt } from '../../../stores/cost-approval/prompt.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { readActive } from '../../../core/sessions/lifecycle.js';
import { transition } from '../../../core/state/machine.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
import type { UseInputModeResult } from './use-input-mode.js';
import { buildRewindAction } from '../../../core/state/build-rewind-action.js';
import { buildPromptCallbacks } from '../prompt-callbacks.js';
import { createRecoveryDriver } from '../recovery-driver.js';

function isWorkflowAborted(controller: AbortController, ref: { current: boolean }): boolean {
  return controller.signal.aborted || ref.current;
}

interface UseWorkflowRunnerOptions {
  feature: string;
  plannerContext?: string | undefined;
  projectDir: string;
  config: Config;
  onComplete: (summary: Summary) => void;
  initialResumeState?: WorkflowState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  inputMode: UseInputModeResult;
  sessionId?: string | undefined;
  enabled?: boolean | undefined;
}

interface UseWorkflowRunnerResult {
  startedAt: string;
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
  enabled = true,
}: UseWorkflowRunnerOptions): UseWorkflowRunnerResult {
  const abortedRef = useRef(false);
  const pendingRewindEventRef = useRef<EngineEvent | null>(null);
  const [startedAt] = useState(() => nowIso());
  const [runId, setRunId] = useState(0);
  const [inlineResume, setInlineResume] = useState<WorkflowState | undefined>(undefined);

  const resumeState = inlineResume ?? initialResumeState;

  const sinks: WorkflowSinks = {
    setAbortHandler,
    setClearQueueHandler,
    setQueueHandler,
  };

  const buildCallbacks = buildPromptCallbacks();
  const recoveryDriverFactory = createRecoveryDriver();

  const startWorkflow = useEffectEvent(async (controller: AbortController) => {
    let stateForRun = resumeState;
    let activeSessionId = initialSessionId;
    let recoveryPromptAlreadyPublished = false;

    resetWorkflow(stateForRun);
    if (pendingRewindEventRef.current) {
      addEvent(pendingRewindEventRef.current);
      pendingRewindEventRef.current = null;
    }
    conversationScrollStore.reset();
    setCancelHandler(() => {
      inputMode.resetMode();
      controller.abort();
    });
    setRewindHandler((request) => {
      inputMode.resetMode();
      const rewindSessionId = activeSessionId ?? readActive(projectDir);
      if (!rewindSessionId) return;
      const ref = { projectDir, sessionId: rewindSessionId };
      const current = loadState(ref);
      if (!current) return;

      const { action, event } = buildRewindAction(request, ref, current);
      let next = transition(current, action);
      if (request.target === 'task' && next.pendingRecovery?.taskId === request.taskId) {
        next = transition(next, { type: 'RESOLVE_PENDING_RECOVERY' });
      }
      saveState(ref, next);
      pendingRewindEventRef.current = event;
      controller.abort(WORKFLOW_REWIND_ABORT_REASON);
      setInlineResume(next);
      setRunId((id) => id + 1);
    });

    const promptPendingRecovery = recoveryDriverFactory({
      projectDir,
      config,
      inputMode,
      abortedRef,
      setInlineResume,
    });

    try {
      let retryProfileOverride: string | undefined;
      let retryProfileOverrideTaskId: TaskId | undefined;
      while (!isWorkflowAborted(controller, abortedRef)) {
        if (stateForRun?.pendingRecovery) {
          activeSessionId = activeSessionId ?? readActive(projectDir) ?? undefined;
          if (!activeSessionId) {
            feedbackStore.setError('No active session found for pending recovery.');
            return;
          }
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
        const summary = await runWorkflow({
          feature,
          plannerContext,
          projectDir,
          config,
          sinks,
          tuiSink: createTuiSink(),
          modelCache: modelCacheStore,
          drainPendingAttachments: () => attachmentsStore.drain(),
          streamingSink: storeStreamingSink,
          signal: controller.signal,
          callbacks: buildCallbacks({
            inputMode,
            abortedRef,
            controller,
            onComplete,
          }),
          savedState: stateForRun,
          selectedSkills,
          sessionId: activeSessionId,
          ...(detectedContextLength !== undefined && { detectedContextLength }),
          ...(retryProfileOverride !== undefined && { retryProfileOverride }),
          ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
        });
        retryProfileOverride = undefined;
        retryProfileOverrideTaskId = undefined;

        if (isWorkflowAborted(controller, abortedRef)) return;

        const savedSessionId = activeSessionId ?? readActive(projectDir) ?? undefined;
        const saved = savedSessionId ? loadState({ projectDir, sessionId: savedSessionId }) : null;

        // A failed final-review gate returns without onComplete and leaves the phase at
        // 'final-review' (a LIVE_PHASE). Drive the screen to the terminal summary view so
        // the user is not stranded on a live-looking workflow screen.
        if (!saved?.pendingRecovery && saved?.phase === 'final-review') {
          onComplete(summary);
          return;
        }
        if (!saved?.pendingRecovery) return;

        activeSessionId = savedSessionId;
        stateForRun = saved;
        setInlineResume(saved);
        recoveryPromptAlreadyPublished = true;
      }
    } catch (err) {
      if (!isWorkflowAborted(controller, abortedRef) && !lifecycleStore.get().cancelled) {
        addEvent({
          type: 'error',
          ts: Date.now(),
          phase: lifecycleStore.get().phase,
          message: toErrorMessage(err),
        });
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
    const sessionId = initialSessionId ?? readActive(projectDir);
    const saved = sessionId ? loadState({ projectDir, sessionId }) : null;
    if (!saved || !sessionId) {
      feedbackStore.setError('No saved state to resume. Press ESC to return home.');
      return;
    }
    const text = injectedText?.trim();
    let next = saved;
    if (text) {
      const message: QueuedMessage = {
        id: randomUUID(),
        text,
        queuedAt: nowIso(),
        phase: saved.phase,
        deliveredViaNative: false,
        origin: 'user-input',
      };
      next = transition(saved, { type: 'ENQUEUE_USER_MSG', message });
      saveState({ projectDir, sessionId }, next);
    }
    setInlineResume(next);
    setRunId((id) => id + 1);
  };

  return { startedAt, handleResume };
}
