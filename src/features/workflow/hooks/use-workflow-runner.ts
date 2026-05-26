import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { Config } from '../../../core/schemas/config.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import { addEvent, resetWorkflow } from '../../../stores/workflow/actions.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { attachmentsStore } from '../../../stores/workflow/attachments.js';
import { runWorkflow, WORKFLOW_REWIND_ABORT_REASON } from '../../../engine/orchestrator/run/run.js';
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
import { loadState, saveState } from '../../../core/state/persistence.js';
import { readActive } from '../../../core/sessions/lifecycle.js';
import { transition } from '../../../core/state/machine.js';
import type { UseInputModeResult } from './use-input-mode.js';
import { buildRewindAction } from './build-rewind-action.js';
import { usePromptCallbacks } from './use-prompt-callbacks.js';
import { useRecoveryDriver } from './use-recovery-driver.js';

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
  handleResume: () => void;
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
  const [startedAt] = useState(() => new Date().toISOString());
  const [runId, setRunId] = useState(0);
  const [inlineResume, setInlineResume] = useState<WorkflowState | undefined>(undefined);

  const resumeState = inlineResume ?? initialResumeState;

  const sinks: WorkflowSinks = {
    setAbortHandler,
    setClearQueueHandler,
    setQueueHandler,
  };

  const buildCallbacks = usePromptCallbacks();
  const createRecoveryDriver = useRecoveryDriver();

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
      const activeSessionId = readActive(projectDir);
      if (!activeSessionId) return;
      const current = loadState(projectDir, activeSessionId);
      if (!current) return;

      const { action, event } = buildRewindAction(request, projectDir, activeSessionId, current);
      const next = transition(current, action);
      saveState(projectDir, activeSessionId, next);
      pendingRewindEventRef.current = event;
      controller.abort(WORKFLOW_REWIND_ABORT_REASON);
      setInlineResume(next);
      setRunId(id => id + 1);
    });

    const promptPendingRecovery = createRecoveryDriver({
      projectDir,
      config,
      inputMode,
      abortedRef,
      setInlineResume,
    });

    try {
      let retryProfileOverride: string | undefined;
      let retryProfileOverrideTaskId: TaskId | undefined;
      while (!controller.signal.aborted && !abortedRef.current) {
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
          pushLines: (lines) => streamingOutputStore.pushLines(lines),
          stop: () => streamingOutputStore.stopStreaming(),
        };

        await runWorkflow({
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
          ...(retryProfileOverride !== undefined && { retryProfileOverride }),
          ...(retryProfileOverrideTaskId !== undefined && { retryProfileOverrideTaskId }),
        });
        retryProfileOverride = undefined;
        retryProfileOverrideTaskId = undefined;

        if (controller.signal.aborted || abortedRef.current) return;

        const savedSessionId = readActive(projectDir) ?? activeSessionId;
        const saved = savedSessionId ? loadState(projectDir, savedSessionId) : null;
        if (!saved?.pendingRecovery) return;

        activeSessionId = savedSessionId;
        stateForRun = saved;
        setInlineResume(saved);
        recoveryPromptAlreadyPublished = true;
      }
    } catch (err) {
      if (!controller.signal.aborted && !abortedRef.current && !lifecycleStore.get().cancelled) {
        addEvent({ type: 'error', ts: Date.now(), phase: lifecycleStore.get().phase, message: String(err) });
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
    };
  // config is intentionally excluded from the dep array: config changes mid-workflow
  // should NOT restart the workflow. The latest config is captured via useEffectEvent
  // when startWorkflow fires.
  }, [enabled, feature, projectDir, runId]);

  const handleResume = () => {
    const sessionId = readActive(projectDir);
    const saved = sessionId ? loadState(projectDir, sessionId) : null;
    if (!saved) {
      feedbackStore.setError('No saved state to resume. Press ESC to return home.');
      return;
    }
    setInlineResume(saved);
    setRunId(id => id + 1);
  };

  return { startedAt, handleResume };
}
