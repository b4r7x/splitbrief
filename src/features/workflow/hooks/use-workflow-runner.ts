import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type { SkillMeta } from '../../../engine/skills/discovery.js';
import { addEvent, resetWorkflow } from '../../../stores/workflow/actions.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { runWorkflow } from '../../../engine/orchestrator/run/run.js';
import type { WorkflowSinks } from '../../../engine/orchestrator/types.js';
import {
  setAbortHandler,
  setCancelHandler,
  setQueueHandler,
  setRewindHandler,
  clearAllHandlers,
} from '../handlers.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { readActive } from '../../../core/sessions/lifecycle.js';
import { transition } from '../../../core/state/machine.js';
import { REVIEW_HINT } from '../review-parser.js';
import type { UseInputModeResult } from './use-input-mode.js';
import { buildRewindAction } from './build-rewind-action.js';

interface UseWorkflowRunnerOptions {
  feature: string;
  projectDir: string;
  config: Config;
  onComplete: (summary: Summary) => void;
  initialResumeState?: WorkflowState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  inputMode: UseInputModeResult;
  sessionId?: string | undefined;
}

interface UseWorkflowRunnerResult {
  startedAt: string;
  handleResume: () => void;
}

export function useWorkflowRunner({
  feature,
  projectDir,
  config,
  onComplete,
  initialResumeState,
  selectedSkills,
  inputMode,
  sessionId: initialSessionId,
}: UseWorkflowRunnerOptions): UseWorkflowRunnerResult {
  const abortedRef = useRef(false);
  const pendingRewindEventRef = useRef<EngineEvent | null>(null);
  const [startedAt] = useState(() => new Date().toISOString());
  const [runId, setRunId] = useState(0);
  const [inlineResume, setInlineResume] = useState<WorkflowState | undefined>(undefined);

  const resumeState = inlineResume ?? initialResumeState;

  const sinks: WorkflowSinks = {
    setAbortHandler,
    setQueueHandler,
  };

  const startWorkflow = useEffectEvent((controller: AbortController) => {
    resetWorkflow(resumeState);
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
      controller.abort();
      setInlineResume(next);
      setRunId(id => id + 1);
    });

    runWorkflow({
      feature,
      projectDir,
      config,
      sinks,
      signal: controller.signal,
      callbacks: {
        onApprovalNeeded: async (_type, filePath) => {
          reviewStore.setReviewFile(filePath);
          const result = await inputMode.setReviewMode(REVIEW_HINT);
          reviewStore.clearReview();
          return result;
        },
        onExternalChanges: async () =>
          (await inputMode.setReviewMode('External changes detected. continue / quit')).approved,
        onBudgetExceeded: async (currentCost, maxBudget) =>
          (await inputMode.setReviewMode(`Budget exceeded: $${currentCost.toFixed(2)} of $${maxBudget.toFixed(2)}. continue / quit`)).approved,
        onContinuationNeeded: async (_partial) =>
          inputMode.setQuestionMode('Task interrupted. Enter instructions to continue (or press Enter to retry):'),
        onQuestionAsked: (question, num, total) =>
          inputMode.setQuestionMode(`Question ${num}/${total}: ${question.text}`),
        onComplete: (summary) => {
          if (!abortedRef.current) onComplete(summary);
        },
      },
      savedState: resumeState,
      selectedSkills,
      sessionId: initialSessionId,
    }).catch((err) => {
      if (!abortedRef.current && !lifecycleStore.get().cancelled) {
        addEvent({ type: 'error', ts: Date.now(), phase: lifecycleStore.get().phase, message: String(err) });
      }
    });
  });

  useEffect(() => {
    abortedRef.current = false;
    const controller = new AbortController();
    startWorkflow(controller);
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
  }, [feature, projectDir, runId]);

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
