import { useRef, useEffect, useEffectEvent, useState } from 'react';
import type { Config, Summary, WorkflowState, SkillMeta, TuiEvent } from '../types.js';
import { workflowStore } from '../stores/workflow.js';
import { reviewStore } from '../stores/review.js';
import { feedbackStore } from '../stores/feedback.js';
import { conversationScrollStore } from '../stores/conversation-scroll.js';
import { runWorkflow } from '../engine/orchestrator/index.js';
import { killAllProcesses } from '../utils/process.js';
import { loadState } from '../core/state/persistence.js';
import { REVIEW_HINT } from '../core/commands/review-commands.js';
import type { UseInputModeResult } from './use-input-mode.js';

interface UseWorkflowRunnerOptions {
  feature: string;
  projectDir: string;
  config: Config;
  onComplete: (summary: Summary) => void;
  initialResumeState?: WorkflowState | undefined;
  selectedSkills?: SkillMeta[] | undefined;
  inputMode: UseInputModeResult;
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
}: UseWorkflowRunnerOptions): UseWorkflowRunnerResult {
  const abortedRef = useRef(false);
  const [startedAt] = useState(() => new Date().toISOString());
  const [runId, setRunId] = useState(0);
  const [inlineResume, setInlineResume] = useState<WorkflowState | undefined>(undefined);

  const resumeState = inlineResume ?? initialResumeState;

  const startWorkflow = useEffectEvent((controller: AbortController) => {
    workflowStore.reset({
      phase: resumeState?.phase ?? 'idle',
      currentTask: resumeState?.currentTaskIndex ?? 0,
      totalTasks: resumeState?.tasks?.length ?? 0,
    });
    conversationScrollStore.reset();
    workflowStore.setCancelHandler(() => controller.abort());

    const addEvent = (event: TuiEvent) => {
      if (abortedRef.current) return;
      workflowStore.addEvent(event);
    };

    runWorkflow({
      feature,
      projectDir,
      config,
      signal: controller.signal,
      callbacks: {
        onEvent: addEvent,
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
        onQuestionAsked: (question, num, total) =>
          inputMode.setQuestionMode(`Question ${num}/${total}: ${question.text}`),
        onComplete: (summary) => {
          if (!abortedRef.current) onComplete(summary);
        },
      },
      savedState: resumeState,
      selectedSkills,
    }).catch((err) => {
      if (!abortedRef.current && !workflowStore.get().cancelled) {
        workflowStore.addEvent({ type: 'error', ts: Date.now(), message: String(err) });
      }
    });
  });

  useEffect(() => {
    abortedRef.current = false;
    const controller = new AbortController();
    startWorkflow(controller);
    return () => {
      abortedRef.current = true;
      controller.abort();
      workflowStore.setCancelHandler(null);
      inputMode.resetMode();
      killAllProcesses();
    };
  // config is intentionally excluded from the dep array: config changes mid-workflow
  // should NOT restart the workflow. The latest config is captured via useEffectEvent
  // when startWorkflow fires.
  }, [feature, projectDir, runId]);

  const handleResume = () => {
    const saved = loadState(projectDir);
    if (!saved) {
      feedbackStore.setError('No saved state to resume. Press ESC to return home.');
      return;
    }
    setInlineResume(saved);
    setRunId(id => id + 1);
  };

  return { startedAt, handleResume };
}
